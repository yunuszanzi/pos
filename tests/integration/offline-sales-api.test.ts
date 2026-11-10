// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mockCalls } from "../../server/fbr/adapters/mock";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteStaffWithPermissions, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

// v0.9 slice 3 against the real API and database: sales rung up offline and sent later. The offline reference and the real time of
// the sale ride in headers, so sending the same sale again can never post it twice; trouble is flagged, not refused.

async function setup(stock = 100) {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: `sku,quantity,unit,cost\nA,${stock},Piece,1.00` }, idempotencyKey: key() });
  expect(opening.status).toBe(201);
  const as = { terminalId: business.terminalId };
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
  const client = sql();
  const methods = Object.fromEntries((await client<{ id: string; code: string }[]>`SELECT id, code FROM payment_methods WHERE business_id = ${business.businessId}`).map((row) => [row.code, row.id]));
  await client.end();
  return { business, product, as, shiftId: shift.body.id as string, methods };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const body = (context: Setup, quantity = "1", extra: Record<string, unknown> = {}) => ({
  shiftId: context.shiftId, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity }],
  payments: [{ methodId: context.methods.cash, amountPaisa: Number(quantity) * 500 }], ...extra,
});
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const offlineHeaders = (reference: string, soldAt = minutesAgo(30)) => ({ "X-Offline-Ref": reference, "X-Offline-Sold-At": soldAt });
const sellOffline = (context: Setup, reference: string, options: { soldAt?: string; idempotencyKey?: string; body?: Record<string, unknown>; token?: string } = {}) =>
  callApi(options.token ?? context.business.ownerToken, "POST", "/sales", {
    ...context.as, idempotencyKey: options.idempotencyKey ?? key(), headers: offlineHeaders(reference, options.soldAt), body: options.body ?? body(context),
  });
const onHand = async (context: Setup) => (await callApi(context.business.ownerToken, "GET", "/stock?pageSize=10")).body.data[0].onHand as string;

integration("offline sales", { timeout: 300_000 }, () => {
  it("posts a sale made earlier at the time it was made, with its slip reference, in the normal way", async () => {
    const context = await setup();
    const soldAt = minutesAgo(45);
    const sale = await sellOffline(context, "REGISTER1-OFF-000001", { soldAt });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.offline).toEqual({ reference: "REGISTER1-OFF-000001", flags: [] });
    expect(sale.body.invoice.number).toBe("INV-KHI-000001");
    expect(new Date(sale.body.invoice.postedAt).toISOString()).toBe(soldAt);
    expect(await onHand(context)).toBe("99");

    const client = sql();
    try {
      const [row] = await client<{ offline_ref: string }[]>`SELECT offline_ref FROM sales_invoices WHERE id = ${sale.body.invoice.id}`;
      expect(row.offline_ref).toBe("REGISTER1-OFF-000001");
      // Still immutable: neither the total nor the reference can be touched afterwards.
      await expect(client`UPDATE sales_invoices SET total_paisa = 1 WHERE id = ${sale.body.invoice.id}`).rejects.toThrow(/cannot be changed/);
      await expect(client`UPDATE sales_invoices SET offline_ref = 'OTHER-1' WHERE id = ${sale.body.invoice.id}`).rejects.toThrow(/cannot be changed/);
      await expect(client`UPDATE sales_invoices SET posted_at = now() WHERE id = ${sale.body.invoice.id}`).rejects.toThrow(/cannot be changed/);
    } finally {
      await client.end();
    }
  });

  it("acceptance 2: ten sales sent in order are numbered in order, once each, and none twice even when sent again", async () => {
    const context = await setup();
    const sent: Array<{ ref: string; idempotencyKey: string; soldAt: string; number: string }> = [];
    for (let n = 1; n <= 10; n += 1) {
      const ref = `REGISTER1-OFF-${String(n).padStart(6, "0")}`;
      const idempotencyKey = key();
      const soldAt = minutesAgo(60 - n);
      const sale = await sellOffline(context, ref, { idempotencyKey, soldAt });
      expect(sale.status, JSON.stringify(sale.body)).toBe(201);
      sent.push({ ref, idempotencyKey, soldAt, number: sale.body.invoice.number });
    }
    expect(sent.map((entry) => entry.number)).toEqual(Array.from({ length: 10 }, (_, index) => `INV-KHI-${String(index + 1).padStart(6, "0")}`));
    // The whole queue sent again (a lost reply, a second tab): every answer is the stored one, nothing new is posted.
    for (const entry of sent) {
      const again = await sellOffline(context, entry.ref, { idempotencyKey: entry.idempotencyKey, soldAt: entry.soldAt });
      expect(again.status).toBe(201);
      expect(again.headers.get("Idempotent-Replay")).toBe("true");
      expect(again.body.invoice.number).toBe(entry.number);
    }
    const client = sql();
    const [{ count }] = await client<{ count: string }[]>`SELECT count(*)::text AS count FROM sales_invoices WHERE business_id = ${context.business.businessId}`;
    await client.end();
    expect(Number(count)).toBe(10);
    expect(await onHand(context)).toBe("90");
  });

  it("a sale whose first, online attempt lost its reply is not posted again when the queue sends it", async () => {
    const context = await setup();
    const idempotencyKey = key();
    const online = await callApi(context.business.ownerToken, "POST", "/sales", { ...context.as, idempotencyKey, body: body(context) });
    expect(online.status).toBe(201);
    // The till never heard back, saved it offline, and sends the same sale with the same key and the offline headers.
    const replay = await sellOffline(context, "REGISTER1-OFF-000001", { idempotencyKey });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replay")).toBe("true");
    expect(replay.body.invoice.id).toBe(online.body.invoice.id);
    expect(await onHand(context)).toBe("99");
  });

  it("does not let a different sale reuse a reference", async () => {
    const context = await setup();
    expect((await sellOffline(context, "REGISTER1-OFF-000001")).status).toBe(201);
    const clash = await sellOffline(context, "REGISTER1-OFF-000001", { body: body(context, "2") });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("OFFLINE_REFERENCE_USED");
    expect(await onHand(context)).toBe("99");
  });

  it("posts stock that went below zero and flags it, where the same sale online is refused", async () => {
    const context = await setup(2);
    const refused = await callApi(context.business.ownerToken, "POST", "/sales", { ...context.as, idempotencyKey: key(), body: body(context, "5") });
    expect(refused.status).toBe(409);
    const sale = await sellOffline(context, "REGISTER1-OFF-000001", { body: body(context, "5") });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.offline.flags).toEqual(["NEGATIVE_STOCK"]);
    expect(await onHand(context)).toBe("-3");
    const list = await callApi(context.business.ownerToken, "GET", "/offline-sales");
    expect(list.body.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ number: "INV-KHI-000001", offlineRef: "REGISTER1-OFF-000001", totalPaisa: 2500, flags: [{ code: "NEGATIVE_STOCK", label: "Stock went below zero" }] });
  });

  it("posts a sale whose price moved while offline and flags it, where online it is refused", async () => {
    const context = await setup();
    // The till showed Rs 4.00 (the old price); the shelf now says Rs 5.00 and the customer handed over Rs 10.
    const stale = { ...body(context), expectedTotalPaisa: 400, payments: [{ methodId: context.methods.cash, amountPaisa: 1000 }] };
    const refused = await callApi(context.business.ownerToken, "POST", "/sales", { ...context.as, idempotencyKey: key(), body: stale });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("TOTAL_CHANGED");
    const sale = await sellOffline(context, "REGISTER1-OFF-000001", { body: stale });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.offline.flags).toEqual(["PRICE_CHANGED"]);
    expect(sale.body.invoice.totalPaisa).toBe(500);
    const [flagged] = (await callApi(context.business.ownerToken, "GET", "/offline-sales")).body.data;
    expect(flagged.detail).toMatchObject({ expectedTotalPaisa: 400, actualTotalPaisa: 500 });
  });

  it("posts a discount above the cashier's limit and flags it, where online it needs a manager", async () => {
    const context = await setup();
    const cashier = await inviteStaffWithPermissions(context.business, "Counter cashier", ["sales.create", "sales.discount", "shifts.open", "inventory.view"]);
    const discounted = body(context, "1", { invoiceDiscount: { type: "percent", bps: 5000 }, payments: [{ methodId: context.methods.cash, amountPaisa: 250 }] });
    const refused = await callApi(cashier.token, "POST", "/sales", { ...context.as, idempotencyKey: key(), body: discounted });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("DISCOUNT_APPROVAL_REQUIRED");
    const sale = await sellOffline(context, "REGISTER1-OFF-000001", { body: discounted, token: cashier.token });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.offline.flags).toEqual(["DISCOUNT_OVER_LIMIT"]);
    expect(sale.body.invoice.invoiceDiscountPaisa).toBe(250);
  });

  it("lists what needs a look and records the review, for the right people only", async () => {
    const context = await setup(1);
    const sale = await sellOffline(context, "REGISTER1-OFF-000001", { body: body(context, "3") });
    const id = sale.body.invoice.id as string;
    expect((await callApi(context.business.ownerToken, "GET", "/offline-sales/summary")).body).toEqual({ open: 1 });
    const cashier = await inviteStaffWithPermissions(context.business, "Plain cashier", ["sales.create"]);
    expect((await callApi(cashier.token, "GET", "/offline-sales")).status).toBe(403);
    expect((await callApi(cashier.token, "POST", `/offline-sales/${id}/review`, { body: {}, idempotencyKey: key() })).status).toBe(403);

    const reviewed = await callApi(context.business.ownerToken, "POST", `/offline-sales/${id}/review`, { body: { note: "Stock count was wrong; corrected" }, idempotencyKey: key() });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    expect((await callApi(context.business.ownerToken, "GET", "/offline-sales/summary")).body).toEqual({ open: 0 });
    const done = await callApi(context.business.ownerToken, "GET", "/offline-sales?status=reviewed");
    expect(done.body.data[0]).toMatchObject({ invoiceId: id, reviewNote: "Stock count was wrong; corrected" });
    expect(done.body.data[0].reviewedAt).toBeTruthy();
    // Reviewing again finds nothing to review; another business cannot see it at all.
    expect((await callApi(context.business.ownerToken, "POST", `/offline-sales/${id}/review`, { body: {}, idempotencyKey: key() })).status).toBe(404);
    const other = await createTestBusiness();
    expect((await callApi(other.ownerToken, "POST", `/offline-sales/${id}/review`, { body: {}, idempotencyKey: key() })).status).toBe(404);
    expect((await callApi(other.ownerToken, "GET", "/offline-sales")).body.total).toBe(0);
  });

  it("refuses what cannot be right: no reference, a bad time, the future, or a sale too old to trust", async () => {
    const context = await setup();
    const call = (headers: Record<string, string>) => callApi(context.business.ownerToken, "POST", "/sales", { ...context.as, idempotencyKey: key(), headers, body: body(context) });
    expect((await call({ "X-Offline-Sold-At": minutesAgo(5) })).body.error.code).toBe("OFFLINE_REFERENCE_INVALID");
    expect((await call({ "X-Offline-Ref": "bad ref!", "X-Offline-Sold-At": minutesAgo(5) })).body.error.code).toBe("OFFLINE_REFERENCE_INVALID");
    expect((await call({ "X-Offline-Ref": "OFF-000001" })).body.error.code).toBe("OFFLINE_TIME_INVALID");
    expect((await call({ "X-Offline-Ref": "OFF-000001", "X-Offline-Sold-At": "yesterday-ish" })).body.error.code).toBe("OFFLINE_TIME_INVALID");
    expect((await call({ "X-Offline-Ref": "OFF-000001", "X-Offline-Sold-At": new Date(Date.now() + 3_600_000).toISOString() })).body.error.code).toBe("OFFLINE_TIME_INVALID");
    expect((await call({ "X-Offline-Ref": "OFF-000001", "X-Offline-Sold-At": new Date(Date.now() - 15 * 86_400_000).toISOString() })).body.error.code).toBe("OFFLINE_TOO_OLD");
    expect(await onHand(context)).toBe("100");
  });

  it("is reported to FBR like any sale once it is sent, and an ordinary sale carries no offline marks", async () => {
    const context = await setup();
    expect((await callApi(context.business.ownerToken, "PUT", "/fbr/token", { body: { token: "mock-ok-token" } })).status).toBe(200);
    const tax = await callApi(context.business.ownerToken, "POST", "/tax-categories", { body: { name: "GST 18%", kind: "standard", rateBps: 1800 } });
    await callApi(context.business.ownerToken, "PUT", `/fbr/tax-categories/${tax.body.id}`, { body: { fbrSaleType: "Goods at standard rate (default)" } });
    const taxed = await createSimpleProduct(context.business, "T", 100, { taxCategoryId: tax.body.id, hsCode: "9503.0090" });
    const client = sql();
    await client`UPDATE product_units SET fbr_uom = 'Numbers, pieces, units' WHERE business_id = ${context.business.businessId}`;
    await client.end();
    await callApi(context.business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nT,50,Piece,1.00" }, idempotencyKey: key() });
    const on = await callApi(context.business.ownerToken, "PUT", "/fbr/config", {
      body: { enabled: true, mode: "di", environment: "sandbox", sellerName: "Example Traders (Pvt) Ltd", sellerNtn: "1234567-8", sellerStrn: "17-00-1234-567-89", sellerProvince: "SINDH", sellerAddress: "Shop 4, Saddar, Karachi", cancelWindowHours: 72, buyerIdThresholdPaisa: 5_000_000, confirmUntested: false },
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);

    const before = mockCalls.filter((call) => call.kind === "post").length;
    const sale = await sellOffline(context, "REGISTER1-OFF-000001", {
      body: { shiftId: context.shiftId, lines: [{ variantId: taxed.variantId, unitId: taxed.pieceId, quantity: "2" }], payments: [{ methodId: context.methods.cash, amountPaisa: 1000 }] },
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.invoice.fbrStatus).toBe("accepted");
    expect(sale.body.invoice.fbrIrn).toBeTruthy();
    expect(mockCalls.filter((call) => call.kind === "post").length - before).toBe(1);

    const plain = await callApi(context.business.ownerToken, "POST", "/sales", {
      ...context.as, idempotencyKey: key(),
      body: { shiftId: context.shiftId, lines: [{ variantId: taxed.variantId, unitId: taxed.pieceId, quantity: "1" }], payments: [{ methodId: context.methods.cash, amountPaisa: 500 }] },
    });
    expect(plain.status).toBe(201);
    expect(plain.body).not.toHaveProperty("offline");
  });
});
