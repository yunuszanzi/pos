// @vitest-environment node
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { formatDocumentNumber } from "../../shared/documents";
import { settleTenders, type Tender } from "../../shared/payments";
import { priceCart, type Discount } from "../../shared/pricing";
import { callApi, createSimpleProduct, createTestBusiness, firstLocationId, hasLocalStack, sql, type SimpleProduct, type TestBusiness } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

type Db = ReturnType<typeof sql>;
const FACTORS = { piece: 1, pack: 10, carton: 200 } as const;
const NAMES = { piece: "Piece", pack: "Pack", carton: "Carton" } as const;
type UnitKey = keyof typeof FACTORS;

type SaleLine = { sku: string; product: SimpleProduct; unit?: UnitKey; qty: number; price?: number; rateBps?: number; discount?: Discount };
type SaleOptions = { taxMode?: "inclusive" | "exclusive"; invoiceDiscount?: Discount; tenders?: Tender[]; allowNegative?: boolean; cashRounding?: 0 | 100 | 500 | 1000; reference?: string };

const key = () => `key-${crypto.randomUUID()}`;
const json = (client: Db, value: unknown) => client.json(value as postgres.JSONValue);

async function openStock(business: TestBusiness, sku: string, quantity: number, unit = "Piece", costRupees = "") {
  const csv = ["sku,quantity,unit,cost", `${sku},${quantity},${unit},${costRupees}`].join("\n");
  const response = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv }, idempotencyKey: key() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
}

async function openShift(client: Db, business: TestBusiness, floatPaisa = 0) {
  const [shift] = await client<{ id: string }[]>`
    INSERT INTO shifts (business_id, branch_id, terminal_id, opened_by, opening_float_paisa)
    VALUES (${business.businessId}, ${business.branchId}, ${business.terminalId}, ${business.ownerId}, ${floatPaisa}) RETURNING id
  `;
  return shift.id;
}

async function methodId(client: Db, business: TestBusiness, code: string) {
  const [method] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${business.businessId} AND code = ${code}`;
  return method.id;
}

/** A sale payload as the API will build it: amounts from the shared pricing code, ready for post_sales_invoice. */
async function buildSale(client: Db, business: TestBusiness, shiftId: string, lines: SaleLine[], options: SaleOptions = {}) {
  const taxMode = options.taxMode ?? "exclusive";
  const priced = priceCart({
    taxMode,
    cashRounding: options.cashRounding ?? 0,
    invoiceDiscount: options.invoiceDiscount,
    lines: lines.map((line) => ({ qtyMilli: line.qty * 1000, unitPricePaisa: line.price ?? 500, taxRateBps: line.rateBps ?? 0, discount: line.discount })),
  });
  const cashId = await methodId(client, business, "cash");
  const walletId = await methodId(client, business, "jazzcash");
  const tenders = options.tenders ?? [{ kind: "cash", amountPaisa: priced.totalPaisa }];
  const settled = settleTenders(priced.totalPaisa, tenders);
  return {
    business_id: business.businessId,
    branch_id: business.branchId,
    terminal_id: business.terminalId,
    shift_id: shiftId,
    location_id: await firstLocationId(business),
    allow_negative_stock: options.allowNegative ?? false,
    tax_mode: taxMode,
    gross_paisa: priced.grossPaisa,
    line_discount_paisa: priced.lineDiscountPaisa,
    invoice_discount_paisa: priced.invoiceDiscountPaisa,
    taxable_paisa: priced.taxablePaisa,
    tax_paisa: priced.taxPaisa,
    rounding_paisa: priced.roundingPaisa,
    total_paisa: priced.totalPaisa,
    lines: lines.map((line, index) => {
      const unit = line.unit ?? "piece";
      const unitId = { piece: line.product.pieceId, pack: line.product.packId, carton: line.product.cartonId }[unit];
      const entry = priced.lines[index];
      return {
        line_no: index + 1, variant_id: line.product.variantId, unit_id: unitId, product_name: `Product ${line.sku}`, variant_name: "", sku: line.sku,
        unit_name: NAMES[unit], hs_code: null, qty_entered: String(line.qty), factor_to_base: String(FACTORS[unit]), qty_base: String(line.qty * FACTORS[unit]),
        unit_price_paisa: line.price ?? 500, gross_paisa: entry.grossPaisa, line_discount_paisa: entry.lineDiscountPaisa,
        invoice_discount_share_paisa: entry.invoiceDiscountSharePaisa, net_paisa: entry.netPaisa, tax_rate_bps: line.rateBps ?? 0,
        tax_included: taxMode === "inclusive", taxable_paisa: entry.taxablePaisa, tax_paisa: entry.taxPaisa, total_paisa: entry.totalPaisa,
      };
    }),
    payments: tenders.map((tender, index) => ({
      method_id: tender.kind === "cash" ? cashId : walletId,
      amount_paisa: settled.tenders[index].appliedPaisa,
      tendered_paisa: settled.tenders[index].tenderedPaisa,
      change_paisa: settled.tenders[index].changePaisa,
      reference: tender.kind === "cash" ? "" : (options.reference ?? "JC-1"),
    })),
  };
}

const post = (client: Db, business: TestBusiness, payload: unknown) =>
  client<{ id: string }[]>`SELECT post_sales_invoice(${json(client, payload)}::jsonb, ${business.ownerId}) AS id`.then((rows) => rows[0].id);

async function onHand(client: Db, variantId: string) {
  const [row] = await client<{ on_hand: string }[]>`SELECT on_hand FROM stock_balances WHERE variant_id = ${variantId}`;
  return row ? Number(row.on_hand) : 0;
}

const messageOf = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no error";
};

integration("sales posting in the database", { timeout: 120_000 }, () => {
  it("posts a sale: invoice, lines, payments and stock together, at the average cost", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "S-1", 100);
    await openStock(business, "S-1", 100, "Piece", "1.00");
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      const payload = await buildSale(client, business, shiftId, [{ sku: "S-1", product, qty: 3, price: 500, rateBps: 1800 }], { tenders: [{ kind: "cash", amountPaisa: 2000 }] });
      const invoiceId = await post(client, business, payload);

      const [invoice] = await client`SELECT * FROM sales_invoices WHERE id = ${invoiceId}`;
      expect(invoice).toMatchObject({ number: "INV-KHI-000001", sequence_no: 1, tax_mode: "exclusive", customer_id: null, cashier_id: business.ownerId });
      expect(Number(invoice.gross_paisa)).toBe(1500);
      expect(Number(invoice.tax_paisa)).toBe(270);
      expect(Number(invoice.total_paisa)).toBe(1770);
      expect([Number(invoice.paid_paisa), Number(invoice.change_paisa), Number(invoice.balance_paisa)]).toEqual([1770, 230, 0]);

      const [line] = await client`SELECT * FROM sales_invoice_lines WHERE invoice_id = ${invoiceId}`;
      expect(line).toMatchObject({ line_no: 1, sku: "S-1", unit_name: "Piece", product_name: "Product S-1", tax_included: false });
      expect([Number(line.qty_base), Number(line.cost_paisa), Number(line.total_paisa), Number(line.returned_qty_base)]).toEqual([3, 100, 1770, 0]);

      const [payment] = await client`SELECT * FROM payments WHERE invoice_id = ${invoiceId}`;
      expect(payment).toMatchObject({ method_code: "cash", tender_kind: "cash" });
      expect([Number(payment.amount_paisa), Number(payment.tendered_paisa), Number(payment.change_paisa)]).toEqual([1770, 2000, 230]);

      expect(await onHand(client, product.variantId)).toBe(97);
      const [entry] = await client`SELECT * FROM stock_ledger WHERE doc_id = ${invoiceId}`;
      expect(entry).toMatchObject({ doc_type: "sales_invoice" });
      expect([Number(entry.qty_base), Number(entry.unit_cost_paisa)]).toEqual([-3, 100]);
    } finally {
      await client.end();
    }
  });

  it("sells in packs and cartons, takes stock in base units, and splits payment between cash and a wallet", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "S-2", 100);
    await openStock(business, "S-2", 5, "Carton", "100.00"); // 1000 pieces at Rs 0.50
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      const payload = await buildSale(client, business, shiftId, [
        { sku: "S-2", product, unit: "carton", qty: 2, price: 90000 },
        { sku: "S-2", product, unit: "pack", qty: 3, price: 4800 },
      ], { tenders: [{ kind: "other", amountPaisa: 100000 }, { kind: "cash", amountPaisa: 100000 }], reference: "JC-77" });
      const invoiceId = await post(client, business, payload);

      expect(await onHand(client, product.variantId)).toBe(1000 - 400 - 30);
      const ledger = await client`SELECT qty_base, unit_cost_paisa FROM stock_ledger WHERE doc_id = ${invoiceId} ORDER BY qty_base`;
      expect(ledger.map((row) => [Number(row.qty_base), Number(row.unit_cost_paisa)])).toEqual([[-400, 50], [-30, 50]]);
      const payments = await client`SELECT method_code, tender_kind, amount_paisa, tendered_paisa, change_paisa, reference FROM payments WHERE invoice_id = ${invoiceId} ORDER BY method_code`;
      // 2 cartons (Rs 1,800) + 3 packs (Rs 144) = Rs 1,944: Rs 1,000 on JazzCash, the other Rs 944 in cash from Rs 1,000 handed over.
      expect(payments.map((row) => [row.method_code, Number(row.amount_paisa), Number(row.tendered_paisa), Number(row.change_paisa), row.reference])).toEqual([
        ["cash", 94400, 100000, 5600, ""],
        ["jazzcash", 100000, 100000, 0, "JC-77"],
      ]);
    } finally {
      await client.end();
    }
  });

  it("numbers invoices without gaps: a failed sale, or one rolled back after taking a number, gives it back", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "S-3", 100);
    await openStock(business, "S-3", 10);
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      const sale = (qty: number) => buildSale(client, business, shiftId, [{ sku: "S-3", product, qty }]);
      const numberOf = async (invoiceId: string) => (await client<{ number: string }[]>`SELECT number FROM sales_invoices WHERE id = ${invoiceId}`)[0].number;

      expect(await numberOf(await post(client, business, await sale(1)))).toBe("INV-KHI-000001");
      expect(await messageOf(post(client, business, await sale(50)))).toContain("STOCK_INSUFFICIENT");
      // Built first: this connection is busy inside the transaction below.
      const abandoned = await sale(1);
      await expect(client.begin(async (transaction) => {
        await transaction`SELECT post_sales_invoice(${json(client, abandoned)}::jsonb, ${business.ownerId})`;
        throw new Error("the caller gives up after the number was taken");
      })).rejects.toThrow(/gives up/);
      expect(await numberOf(await post(client, business, await sale(1)))).toBe("INV-KHI-000002");
      const numbers = await client<{ sequence_no: number }[]>`SELECT sequence_no FROM sales_invoices WHERE business_id = ${business.businessId} ORDER BY sequence_no`;
      expect(numbers.map((row) => row.sequence_no)).toEqual([1, 2]);
    } finally {
      await client.end();
    }
  });

  it("builds the invoice number the same way as the shared code, including past six digits", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "S-4", 100);
    await openStock(business, "S-4", 10);
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      for (const next of [1, 42, 999999, 1234567]) {
        await client`UPDATE document_series SET next_number = ${next} WHERE business_id = ${business.businessId} AND branch_id = ${business.branchId} AND doc_type = 'invoice'`;
        const invoiceId = await post(client, business, await buildSale(client, business, shiftId, [{ sku: "S-4", product, qty: 1 }]));
        const [invoice] = await client<{ number: string; sequence_no: number }[]>`SELECT number, sequence_no FROM sales_invoices WHERE id = ${invoiceId}`;
        expect(invoice.number).toBe(formatDocumentNumber("INV-KHI", next));
        expect(invoice.sequence_no).toBe(next);
      }
    } finally {
      await client.end();
    }
  });

  it("never sells the last unit twice: of ten simultaneous sales for four units, exactly four succeed with consecutive numbers", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "S-5", 100);
    await openStock(business, "S-5", 4);
    const setup = sql();
    const connections = Array.from({ length: 10 }, () => sql());
    try {
      const shiftId = await openShift(setup, business);
      const payload = await buildSale(setup, business, shiftId, [{ sku: "S-5", product, qty: 1 }]);
      const results = await Promise.allSettled(connections.map((connection) => post(connection, business, payload)));
      const succeeded = results.filter((result) => result.status === "fulfilled");
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(succeeded).toHaveLength(4);
      expect(failed).toHaveLength(6);
      for (const result of failed) expect(String(result.reason)).toContain("STOCK_INSUFFICIENT");
      expect(await onHand(setup, product.variantId)).toBe(0);
      const numbers = await setup<{ sequence_no: number }[]>`SELECT sequence_no FROM sales_invoices WHERE business_id = ${business.businessId} ORDER BY sequence_no`;
      expect(numbers.map((row) => row.sequence_no)).toEqual([1, 2, 3, 4]);
    } finally {
      await Promise.all([setup.end(), ...connections.map((connection) => connection.end())]);
    }
  });

  it("lets stock go negative only when the business allows it", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "S-6", 100);
    await openStock(business, "S-6", 2);
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      const refused = await buildSale(client, business, shiftId, [{ sku: "S-6", product, qty: 5 }]);
      expect(await messageOf(post(client, business, refused))).toMatch(/STOCK_INSUFFICIENT: variant [0-9a-f-]{36} has 2\.000 on hand, needs 5\b/);
      expect(await onHand(client, product.variantId)).toBe(2);
      await post(client, business, await buildSale(client, business, shiftId, [{ sku: "S-6", product, qty: 5 }], { allowNegative: true }));
      expect(await onHand(client, product.variantId)).toBe(-3);
    } finally {
      await client.end();
    }
  });

  it("does not move stock for services, which can be sold with none on hand", async () => {
    const business = await createTestBusiness();
    const service = await createSimpleProduct(business, "SVC-1", 0, { productType: "service" });
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      const invoiceId = await post(client, business, await buildSale(client, business, shiftId, [{ sku: "SVC-1", product: service, qty: 1, price: 25000 }]));
      expect(await client`SELECT 1 FROM stock_ledger WHERE doc_id = ${invoiceId}`).toHaveLength(0);
      expect(await client`SELECT 1 FROM sales_invoices WHERE id = ${invoiceId}`).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it("refuses a sale whose amounts do not add up, however it was built", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "S-7", 100);
    await openStock(business, "S-7", 10);
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      const good = await buildSale(client, business, shiftId, [{ sku: "S-7", product, qty: 2, price: 1000, rateBps: 1800 }]);
      const tampered = (change: (copy: typeof good) => void) => {
        const copy = structuredClone(good);
        change(copy);
        return post(client, business, copy);
      };
      expect(await messageOf(tampered((copy) => { copy.lines[0].total_paisa -= 100; }))).toMatch(/INVOICE_TOTAL_MISMATCH|violates check constraint/);
      expect(await messageOf(tampered((copy) => { copy.total_paisa -= 100; copy.payments[0].amount_paisa -= 100; copy.payments[0].tendered_paisa -= 100; }))).toContain("INVOICE_TOTAL_MISMATCH");
      expect(await messageOf(tampered((copy) => { copy.tax_paisa += 1; }))).toContain("INVOICE_TOTAL_MISMATCH");
      expect(await messageOf(tampered((copy) => { copy.lines[0].qty_base = "3"; }))).toMatch(/qty_base|check constraint/);
      expect(await messageOf(tampered((copy) => { copy.lines[0].net_paisa -= 1; }))).toMatch(/net_paisa|check constraint/);
      expect(await onHand(client, product.variantId)).toBe(10);
      expect(await client`SELECT 1 FROM sales_invoices WHERE business_id = ${business.businessId}`).toHaveLength(0);
      expect(await post(client, business, good)).toBeTruthy();
    } finally {
      await client.end();
    }
  });

  it("refuses payments that do not match the bill, unknown methods, and lines that are not sellable", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "S-8", 100);
    const archived = await createSimpleProduct(business, "S-8-OLD", 100);
    await openStock(business, "S-8", 10);
    await openStock(business, "S-8-OLD", 10);
    await callApi(business.ownerToken, "DELETE", `/products/${archived.productId}`);
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      const good = await buildSale(client, business, shiftId, [{ sku: "S-8", product, qty: 1 }]);
      const attempt = (change: (copy: typeof good) => void) => {
        const copy = structuredClone(good);
        change(copy);
        return messageOf(post(client, business, copy));
      };
      expect(await attempt((copy) => { copy.payments = []; })).toContain("PAYMENT_MISMATCH");
      expect(await attempt((copy) => { copy.payments[0].amount_paisa -= 1; copy.payments[0].tendered_paisa -= 1; })).toContain("PAYMENT_MISMATCH");
      expect(await attempt((copy) => { copy.payments[0].method_id = crypto.randomUUID(); })).toContain("PAYMENT_MISMATCH");
      expect(await attempt((copy) => { copy.payments[0].tendered_paisa += 5; })).toMatch(/tendered_paisa|check constraint/);
      expect(await attempt((copy) => { copy.lines = []; })).toContain("INVALID_LINE");
      expect(await attempt((copy) => { copy.lines[0].variant_id = archived.variantId; })).toContain("INVALID_LINE");
      expect(await attempt((copy) => { copy.lines[0].unit_id = crypto.randomUUID(); })).toContain("INVALID_LINE");
      expect(await attempt((copy) => { copy.lines[0].factor_to_base = "2"; copy.lines[0].qty_base = "2"; })).toContain("INVALID_LINE");
      await client`UPDATE payment_methods SET active = false WHERE business_id = ${business.businessId} AND code = 'jazzcash'`;
      const wallet = await buildSale(client, business, shiftId, [{ sku: "S-8", product, qty: 1 }], { tenders: [{ kind: "other", amountPaisa: 500 }] });
      expect(await messageOf(post(client, business, wallet))).toContain("PAYMENT_MISMATCH");
      expect(await onHand(client, product.variantId)).toBe(10);
    } finally {
      await client.end();
    }
  });

  it("will not sell on a shift that is closed, belongs to another terminal, or does not exist", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "S-9", 100);
    await openStock(business, "S-9", 10);
    const other = await callApi(business.ownerToken, "POST", "/terminals", { body: { branchId: business.branchId, name: "Register 2" } });
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      const payload = await buildSale(client, business, shiftId, [{ sku: "S-9", product, qty: 1 }]);
      expect(await messageOf(post(client, business, { ...payload, shift_id: crypto.randomUUID() }))).toContain("SHIFT_NOT_OPEN");
      expect(await messageOf(post(client, business, { ...payload, terminal_id: other.body.id }))).toContain("SHIFT_NOT_OPEN");
      await client`UPDATE shifts SET status = 'closed', closed_at = now(), closed_by = ${business.ownerId}, counted_paisa = 0, expected_paisa = 0, variance_paisa = 0 WHERE id = ${shiftId}`;
      expect(await messageOf(post(client, business, payload))).toContain("SHIFT_NOT_OPEN");
      expect(await onHand(client, product.variantId)).toBe(10);
    } finally {
      await client.end();
    }
  });

  it("keeps posted documents unchangeable, except the returned quantity on a line", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "S-10", 100);
    await openStock(business, "S-10", 10);
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      const invoiceId = await post(client, business, await buildSale(client, business, shiftId, [{ sku: "S-10", product, qty: 4 }]));
      await expect(client`UPDATE sales_invoices SET total_paisa = 1 WHERE id = ${invoiceId}`).rejects.toThrow(/posted sales invoices cannot be changed/);
      await expect(client`DELETE FROM sales_invoices WHERE id = ${invoiceId}`).rejects.toThrow(/cannot be changed or deleted/);
      await expect(client`UPDATE sales_invoice_lines SET unit_price_paisa = 1 WHERE invoice_id = ${invoiceId}`).rejects.toThrow(/cannot be changed/);
      await expect(client`DELETE FROM sales_invoice_lines WHERE invoice_id = ${invoiceId}`).rejects.toThrow(/cannot be changed or deleted/);
      await expect(client`UPDATE payments SET amount_paisa = 1 WHERE invoice_id = ${invoiceId}`).rejects.toThrow(/cannot be changed/);
      await expect(client`DELETE FROM payments WHERE invoice_id = ${invoiceId}`).rejects.toThrow(/cannot be changed or deleted/);

      await client`UPDATE sales_invoice_lines SET returned_qty_base = 3 WHERE invoice_id = ${invoiceId}`;
      expect(Number((await client`SELECT returned_qty_base FROM sales_invoice_lines WHERE invoice_id = ${invoiceId}`)[0].returned_qty_base)).toBe(3);
      await expect(client`UPDATE sales_invoice_lines SET returned_qty_base = 5 WHERE invoice_id = ${invoiceId}`).rejects.toThrow(/violates check constraint/);
    } finally {
      await client.end();
    }
  });

  it("applies discounts, inclusive tax and cash rounding exactly as the shared code does", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "S-11", 100);
    await openStock(business, "S-11", 100);
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      const options: SaleOptions = { taxMode: "inclusive", invoiceDiscount: { type: "percent", bps: 500 }, cashRounding: 500 };
      const lines: SaleLine[] = [
        { sku: "S-11", product, qty: 3, price: 11813, rateBps: 1800, discount: { type: "percent", bps: 1000 } },
        { sku: "S-11", product, qty: 2, price: 4999, rateBps: 500 },
      ];
      const expected = priceCart({
        taxMode: "inclusive", cashRounding: 500, invoiceDiscount: options.invoiceDiscount,
        lines: lines.map((line) => ({ qtyMilli: line.qty * 1000, unitPricePaisa: line.price ?? 0, taxRateBps: line.rateBps ?? 0, discount: line.discount })),
      });
      const invoiceId = await post(client, business, await buildSale(client, business, shiftId, lines, options));
      const [invoice] = await client`SELECT * FROM sales_invoices WHERE id = ${invoiceId}`;
      expect(Number(invoice.total_paisa)).toBe(expected.totalPaisa);
      expect(Number(invoice.total_paisa) % 500).toBe(0);
      expect(Number(invoice.rounding_paisa)).toBe(expected.roundingPaisa);
      expect(Number(invoice.tax_paisa)).toBe(expected.taxPaisa);
      const stored = await client`SELECT total_paisa, tax_paisa, invoice_discount_share_paisa FROM sales_invoice_lines WHERE invoice_id = ${invoiceId} ORDER BY line_no`;
      expect(stored.map((row) => [Number(row.total_paisa), Number(row.tax_paisa), Number(row.invoice_discount_share_paisa)]))
        .toEqual(expected.lines.map((line) => [line.totalPaisa, line.taxPaisa, line.invoiceDiscountSharePaisa]));
    } finally {
      await client.end();
    }
  });
});

integration("shifts and cash in the database", { timeout: 60_000 }, () => {
  it("allows one open shift per terminal, and a closed shift is final", async () => {
    const business = await createTestBusiness();
    const client = sql();
    try {
      const shiftId = await openShift(client, business, 500000);
      await expect(openShift(client, business)).rejects.toThrow(/shifts_one_open_per_terminal_uidx/);
      await expect(client`UPDATE shifts SET status = 'closed' WHERE id = ${shiftId}`).rejects.toThrow(/shifts_status_check|check constraint/);

      await client`UPDATE shifts SET status = 'closed', closed_at = now(), closed_by = ${business.ownerId}, counted_paisa = 499000, expected_paisa = 500000, variance_paisa = -1000, counted_breakdown = ${json(client, { "1000": 499 })}::jsonb WHERE id = ${shiftId}`;
      await expect(client`UPDATE shifts SET counted_paisa = 500000 WHERE id = ${shiftId}`).rejects.toThrow(/closed shift cannot be changed/);
      await expect(client`DELETE FROM shifts WHERE id = ${shiftId}`).rejects.toThrow(/closed shift cannot be changed/);
      await expect(client`UPDATE shifts SET status = 'closed', variance_paisa = 5 WHERE id = ${await openShift(client, business)}`).rejects.toThrow(/check constraint/);
      // The terminal is free for a new shift once the old one is closed.
      expect(await client`SELECT 1 FROM shifts WHERE terminal_id = ${business.terminalId} AND status = 'open'`).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it("records cash in and out only while the shift is open, and never lets a record change", async () => {
    const business = await createTestBusiness();
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      await client`INSERT INTO cash_movements (business_id, shift_id, kind, amount_paisa, reason) VALUES (${business.businessId}, ${shiftId}, 'cash_out', 20000, 'Tea for staff')`;
      await expect(client`INSERT INTO cash_movements (business_id, shift_id, kind, amount_paisa, reason) VALUES (${business.businessId}, ${shiftId}, 'cash_in', 0, 'x')`).rejects.toThrow(/check constraint/);
      await expect(client`INSERT INTO cash_movements (business_id, shift_id, kind, amount_paisa, reason) VALUES (${business.businessId}, ${shiftId}, 'cash_in', 100, '  ')`).rejects.toThrow(/check constraint/);
      await expect(client`UPDATE cash_movements SET amount_paisa = 1 WHERE shift_id = ${shiftId}`).rejects.toThrow(/append-only/);
      await expect(client`DELETE FROM cash_movements WHERE shift_id = ${shiftId}`).rejects.toThrow(/append-only/);
      await client`UPDATE shifts SET status = 'closed', closed_at = now(), closed_by = ${business.ownerId}, counted_paisa = 0, expected_paisa = 0, variance_paisa = 0 WHERE id = ${shiftId}`;
      await expect(client`INSERT INTO cash_movements (business_id, shift_id, kind, amount_paisa, reason) VALUES (${business.businessId}, ${shiftId}, 'cash_in', 100, 'late')`).rejects.toThrow(/SHIFT_NOT_OPEN/);
    } finally {
      await client.end();
    }
  });

  it("checks the invoice arithmetic in the table itself", async () => {
    const business = await createTestBusiness();
    const client = sql();
    try {
      const shiftId = await openShift(client, business);
      const insert = (total: number, paid: number, customer: string | null) => client`
        INSERT INTO sales_invoices (business_id, branch_id, terminal_id, shift_id, location_id, number, sequence_no, customer_id, cashier_id, tax_mode,
          gross_paisa, line_discount_paisa, invoice_discount_paisa, taxable_paisa, tax_paisa, rounding_paisa, total_paisa, paid_paisa, change_paisa, balance_paisa)
        VALUES (${business.businessId}, ${business.branchId}, ${business.terminalId}, ${shiftId}, (SELECT id FROM locations WHERE business_id = ${business.businessId} LIMIT 1),
          ${`X-${crypto.randomUUID()}`}, 1, ${customer}, ${business.ownerId}, 'exclusive', 1000, 100, 0, 900, 162, 0, ${total}, ${paid}, 0, ${total - paid})`;
      await expect(insert(1000, 1000, null)).rejects.toThrow(/sales_invoices_check/); // 1000 - 100 + 162 is 1062
      await expect(insert(1062, 1000, null)).rejects.toThrow(/sales_invoices_check/); // a walk-in sale cannot leave a balance
      await insert(1062, 1062, null);
    } finally {
      await client.end();
    }
  });
});
