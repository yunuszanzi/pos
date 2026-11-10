import { describe, expect, it } from "vitest";
import { settleTenders } from "../../shared/payments";
import { buildReceipt } from "../../shared/receipt";
import { ApiRequestError, NetworkError } from "../../src/api/client";
import type { PostedSale, SaleInvoice } from "../../src/api/posApi";
import { totalsOf, type Cart } from "../../src/pos/cart";
import { CatalogueIndex } from "../../src/pos/catalogueIndex";
import { buildOfflineInvoice, whyNotOffline } from "../../src/pos/offlineSale";
import { offlineReference, sendQueuedSales, type OutboxStore, type QueuedSale } from "../../src/pos/offlineQueue";
import type { Product } from "../../src/api/productsApi";

// Sales rung up without a connection (technical plan 5.5): the queue sends in order and never twice, one bad sale does not hold up
// the rest, and the slip the customer holds is the bill the shop will book.

class MemoryOutbox implements OutboxStore {
  rows: QueuedSale[] = [];
  private seq = 0;
  private counters = new Map<string, number>();
  async add(sale: Omit<QueuedSale, "seq">) { const seq = ++this.seq; this.rows.push({ ...sale, seq }); return seq; }
  async all() { return [...this.rows].sort((a, b) => a.seq! - b.seq!); }
  async update(seq: number, patch: Partial<Omit<QueuedSale, "seq">>) { this.rows = this.rows.map((row) => (row.seq === seq ? { ...row, ...patch } : row)); }
  async remove(seq: number) { this.rows = this.rows.filter((row) => row.seq !== seq); }
  async nextNumber(terminalId: string) { const next = (this.counters.get(terminalId) ?? 0) + 1; this.counters.set(terminalId, next); return next; }
}

const invoiceOf = (number: string): SaleInvoice => ({
  id: `offline:${number}`, number, offlineRef: number, postedAt: "2026-11-10T09:00:00Z", branchName: "Karachi", terminalName: "Register 1", cashierName: "Ayesha", shiftId: "s", customerId: null, customerName: null,
  customerBalancePaisa: null, taxMode: "inclusive", grossPaisa: 500, lineDiscountPaisa: 0, invoiceDiscountPaisa: 0, taxablePaisa: 424, taxPaisa: 76, roundingPaisa: 0, totalPaisa: 500, paidPaisa: 500,
  changePaisa: 0, balancePaisa: 0, lines: [{ lineNo: 1, variantId: "v", unitId: "u", productName: "Red Balloon", variantName: "", sku: "BAL", unitName: "Piece", hsCode: null, quantity: "1", unitPricePaisa: 500, grossPaisa: 500,
    lineDiscountPaisa: 0, invoiceDiscountSharePaisa: 0, netPaisa: 500, taxRateBps: 1800, taxPaisa: 76, totalPaisa: 500, returnedQuantity: "0" }],
  payments: [{ methodCode: "cash", methodName: "Cash", amountPaisa: 500, tenderedPaisa: 500, changePaisa: 0, reference: "" }],
});
const queued = (n: number): Omit<QueuedSale, "seq"> => ({
  offlineRef: offlineReference("Register 1", n), idempotencyKey: `key-${n}-xxxxxxxx`, terminalId: "t1", soldAt: `2026-11-10T09:0${n}:00Z`,
  request: { shiftId: "s", lines: [], payments: [] }, invoice: invoiceOf(offlineReference("Register 1", n)), status: "queued", attempts: 0, lastError: "", lastErrorCode: "",
});
const postedAs = (item: QueuedSale, number: string): PostedSale => ({ invoice: { ...invoiceOf(number), offlineRef: item.offlineRef }, stock: [] });

describe("slip references", () => {
  it("names the terminal and counts, in a form the server accepts", () => {
    expect(offlineReference("Register 1", 1)).toBe("REGISTER1-OFF-000001");
    expect(offlineReference("Till #3 (back)", 42)).toBe("TILL3BACK-OFF-000042");
    expect(offlineReference("!!!", 7)).toBe("TILL-OFF-000007");
    expect(offlineReference("A very long terminal name indeed", 1).split("-OFF-")[0]).toHaveLength(12);
    expect(offlineReference("Register 1", 1234567)).toMatch(/^[A-Za-z0-9-]{3,40}$/);
  });
});

describe("sending the queue", () => {
  it("sends in the order the sales were made, once each, and clears what was sent", async () => {
    const store = new MemoryOutbox();
    for (const n of [1, 2, 3]) await store.add(queued(n));
    const order: string[] = [];
    let issued = 100;
    const result = await sendQueuedSales(store, async (item) => { order.push(item.offlineRef); return postedAs(item, `INV-${++issued}`); });
    expect(order).toEqual(["REGISTER1-OFF-000001", "REGISTER1-OFF-000002", "REGISTER1-OFF-000003"]);
    expect(result.sent.map((entry) => entry.sale.invoice.number)).toEqual(["INV-101", "INV-102", "INV-103"]);
    expect(result.stopped).toBe(false);
    expect(await store.all()).toEqual([]);
    // Sending again has nothing to send.
    expect((await sendQueuedSales(store, async () => { throw new Error("must not be called"); })).sent).toEqual([]);
  });

  it("stops when the connection goes, keeps what is left in its place, and carries on later without repeating what went", async () => {
    const store = new MemoryOutbox();
    for (const n of [1, 2, 3, 4]) await store.add(queued(n));
    let calls = 0;
    const first = await sendQueuedSales(store, async (item) => {
      calls += 1;
      if (calls === 3) throw new NetworkError();
      return postedAs(item, `INV-${calls}`);
    });
    expect(first.sent).toHaveLength(2);
    expect(first.stopped).toBe(true);
    const left = await store.all();
    expect(left.map((row) => row.offlineRef)).toEqual(["REGISTER1-OFF-000003", "REGISTER1-OFF-000004"]);
    expect(left[0]).toMatchObject({ status: "queued", attempts: 1 });
    const second = await sendQueuedSales(store, async (item) => postedAs(item, `INV-${item.offlineRef}`));
    expect(second.sent.map((entry) => entry.item.offlineRef)).toEqual(["REGISTER1-OFF-000003", "REGISTER1-OFF-000004"]);
  });

  it("keeps the same idempotency key and the same request on every try", async () => {
    const store = new MemoryOutbox();
    await store.add(queued(1));
    const seen: Array<{ key: string; ref: string; soldAt: string }> = [];
    await sendQueuedSales(store, async (item) => { seen.push({ key: item.idempotencyKey, ref: item.offlineRef, soldAt: item.soldAt }); throw new NetworkError(); });
    await sendQueuedSales(store, async (item) => { seen.push({ key: item.idempotencyKey, ref: item.offlineRef, soldAt: item.soldAt }); return postedAs(item, "INV-1"); });
    expect(new Set(seen.map((entry) => JSON.stringify(entry))).size).toBe(1);
  });

  it("marks a sale the server refused, leaves it out of later runs, and does not hold up the rest", async () => {
    const store = new MemoryOutbox();
    for (const n of [1, 2, 3]) await store.add(queued(n));
    const result = await sendQueuedSales(store, async (item) => {
      if (item.offlineRef.endsWith("000002")) throw new ApiRequestError("A payment method is not available", 422, "PAYMENT_MISMATCH");
      return postedAs(item, `INV-${item.offlineRef}`);
    });
    expect(result.sent.map((entry) => entry.item.offlineRef)).toEqual(["REGISTER1-OFF-000001", "REGISTER1-OFF-000003"]);
    expect(result.refused).toHaveLength(1);
    expect(result.stopped).toBe(false);
    const [stuck] = await store.all();
    expect(stuck).toMatchObject({ offlineRef: "REGISTER1-OFF-000002", status: "failed", lastError: "A payment method is not available", lastErrorCode: "PAYMENT_MISMATCH", attempts: 1 });
    // A refused sale is not sent again on its own...
    expect((await sendQueuedSales(store, async () => { throw new Error("must not be called"); })).sent).toEqual([]);
    // ...but is once a person puts it back.
    await store.update(stuck.seq!, { status: "queued" });
    expect((await sendQueuedSales(store, async (item) => postedAs(item, "INV-9"))).sent).toHaveLength(1);
  });

  it("treats a sign-in problem or a server error as 'not now', not as a refusal", async () => {
    for (const status of [401, 500, 503]) {
      const store = new MemoryOutbox();
      await store.add(queued(1));
      await store.add(queued(2));
      const result = await sendQueuedSales(store, async () => { throw new ApiRequestError("nope", status); });
      expect(result.stopped).toBe(true);
      expect(result.refused).toEqual([]);
      expect((await store.all()).map((row) => row.status)).toEqual(["queued", "queued"]);
    }
  });

  it("hands out slip numbers that never repeat", async () => {
    const store = new MemoryOutbox();
    expect([await store.nextNumber("t1"), await store.nextNumber("t1"), await store.nextNumber("t2"), await store.nextNumber("t1")]).toEqual([1, 2, 1, 3]);
  });
});

// ---- the bill written at the till ----

const product = (id: string, name: string, pricePaisa: number, taxCategoryId: string | null): Product => ({
  id, name, active: true, productType: "stocked", categoryId: null, taxCategoryId, baseUnitId: "u-pc",
  variants: [{ id: `${id}-v`, sku: `${name.toUpperCase()}-1`, variantName: "", active: true, costPaisa: 100, reorderLevel: "0", units: [{ unitId: "u-pc", factorToBase: "1", isBase: true, barcode: `${id}-pc`, salePricePaisa: pricePaisa }] }],
} as unknown as Product);
const reference = { units: [{ id: "u-pc", name: "Piece" }], taxCategories: [{ id: "gst", rateBps: 1800 }] };
const catalogue = new CatalogueIndex([product("a", "Red", 500, "gst"), product("b", "Blue", 250, null)], reference as never);
const cart = (lines: Cart["lines"], extra: Partial<Cart> = {}): Cart => ({ lines, invoiceDiscount: null, customerId: null, ...extra });
const line = (id: string, quantityMilli: number, extra: Partial<Cart["lines"][number]> = {}): Cart["lines"][number] => ({ key: `${id}-k`, variantId: `${id}-v`, unitId: "u-pc", quantityMilli, priceOverridePaisa: null, discount: null, ...extra });

describe("the bill written without the server", () => {
  const base = { offlineRef: "REGISTER1-OFF-000001", soldAt: "2026-11-10T09:00:00Z", taxMode: "inclusive" as const, branchName: "Karachi", terminalName: "Register 1", cashierName: "Ayesha", shiftId: "s1", customer: null };

  it("carries the same figures the pricing engine gives, the slip reference as its number, and the payments as tendered", () => {
    const c = cart([line("a", 2000), line("b", 1000)]);
    const totals = totalsOf(c, catalogue, "inclusive", 0)!;
    const settlement = settleTenders(totals.priced.totalPaisa, [{ kind: "cash", amountPaisa: 2000 }]);
    const invoice = buildOfflineInvoice({ ...base, cart: c, totals, settlement, payments: [{ methodCode: "cash", methodName: "Cash", reference: "" }] });
    expect(invoice).toMatchObject({ number: "REGISTER1-OFF-000001", offlineRef: "REGISTER1-OFF-000001", id: "offline:REGISTER1-OFF-000001", grossPaisa: 1250, totalPaisa: 1250, paidPaisa: 1250, changePaisa: 750, balancePaisa: 0 });
    expect(invoice.taxPaisa).toBe(totals.priced.taxPaisa);
    expect(invoice.lines.map((row) => [row.sku, row.quantity, row.unitPricePaisa, row.totalPaisa])).toEqual([["RED-1", "2", 500, 1000], ["BLUE-1", "1", 250, 250]]);
    expect(invoice.payments).toEqual([{ methodCode: "cash", methodName: "Cash", amountPaisa: 1250, tenderedPaisa: 2000, changePaisa: 750, reference: "" }]);
    // The lines add up to the total, to the paisa.
    expect(invoice.lines.reduce((sum, row) => sum + row.totalPaisa, 0)).toBe(invoice.totalPaisa);
  });

  it("splits payments across methods and keeps the customer", () => {
    const c = cart([line("a", 1000)], { customerId: "c1" });
    const totals = totalsOf(c, catalogue, "inclusive", 0)!;
    const settlement = settleTenders(500, [{ kind: "cash", amountPaisa: 200 }, { kind: "other", amountPaisa: 300 }]);
    const invoice = buildOfflineInvoice({ ...base, cart: c, totals, settlement, customer: { id: "c1", name: "Bilal", balancePaisa: 1500 },
      payments: [{ methodCode: "cash", methodName: "Cash", reference: "" }, { methodCode: "jazzcash", methodName: "JazzCash", reference: "JC-1" }] });
    expect(invoice).toMatchObject({ customerId: "c1", customerName: "Bilal", customerBalancePaisa: 1500, paidPaisa: 500, balancePaisa: 0 });
    expect(invoice.payments.map((payment) => [payment.methodCode, payment.amountPaisa, payment.reference])).toEqual([["cash", 200, ""], ["jazzcash", 300, "JC-1"]]);
  });
});

describe("what cannot be done without a connection", () => {
  const totalsFor = (c: Cart) => totalsOf(c, catalogue, "inclusive", 0)!;
  it("allows a plain, fully paid sale", () => {
    const c = cart([line("a", 1000)]);
    expect(whyNotOffline({ cart: c, totals: totalsFor(c), onAccountPaisa: 0, maxDiscountBps: 500, mayDiscountAboveLimit: false })).toBeNull();
  });
  it("refuses credit: the customer's balance and limit live on the server", () => {
    const c = cart([line("a", 1000)], { customerId: "c1" });
    expect(whyNotOffline({ cart: c, totals: totalsFor(c), onAccountPaisa: 500, maxDiscountBps: 500, mayDiscountAboveLimit: false })).toMatch(/on account/);
  });
  it("allows a discount within the cashier's limit and refuses one above it, unless the cashier may go above", () => {
    const small = cart([line("a", 1000, { discount: { type: "percent", bps: 500 } })]);
    const big = cart([line("a", 1000, { discount: { type: "percent", bps: 2000 } })]);
    expect(whyNotOffline({ cart: small, totals: totalsFor(small), onAccountPaisa: 0, maxDiscountBps: 500, mayDiscountAboveLimit: false })).toBeNull();
    expect(whyNotOffline({ cart: big, totals: totalsFor(big), onAccountPaisa: 0, maxDiscountBps: 500, mayDiscountAboveLimit: false })).toMatch(/manager cannot approve/);
    expect(whyNotOffline({ cart: big, totals: totalsFor(big), onAccountPaisa: 0, maxDiscountBps: 500, mayDiscountAboveLimit: true })).toBeNull();
    const bill = cart([line("a", 1000)], { invoiceDiscount: { type: "percent", bps: 1000 } });
    expect(whyNotOffline({ cart: bill, totals: totalsFor(bill), onAccountPaisa: 0, maxDiscountBps: 500, mayDiscountAboveLimit: false })).toMatch(/manager cannot approve/);
  });
});

describe("the slip printed offline", () => {
  const options = { business: { tradeName: "Example Traders", legalName: "Example Traders", address: "Saddar", phone: "", ntn: null, strn: null, receiptFooter: "", logoUrl: null }, dateFormat: "dd/MM/yyyy", timezone: "Asia/Karachi" };
  it("says it is offline and to be synced, under the slip reference, on every format", () => {
    for (const format of ["pos80", "pos58", "a4", "a5"] as const) {
      const model = buildReceipt(invoiceOf("REGISTER1-OFF-000001"), format, options as never);
      expect(model.number).toBe("REGISTER1-OFF-000001");
      expect(model.offlineBanner).toContain("OFFLINE SALE, TO BE SYNCED");
      expect(model.offlineBanner).toContain("REGISTER1-OFF-000001");
    }
  });
  it("leaves an ordinary slip as it was", () => {
    expect(buildReceipt({ ...invoiceOf("INV-KHI-000001"), offlineRef: null }, "pos80", options as never)).not.toHaveProperty("offlineBanner");
    expect(buildReceipt({ ...invoiceOf("INV-KHI-000001"), offlineRef: undefined }, "pos80", options as never)).not.toHaveProperty("offlineBanner");
  });
});
