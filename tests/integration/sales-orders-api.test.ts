import { businessToday } from "../../shared/dates";
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const inDays = (days: number) => new Date(Date.parse(businessToday()) + days * 86_400_000).toISOString().slice(0, 10);

// v0.6 slice 3 against the real API and database: sales orders reserve stock; a quotation becomes an order at the quoted prices.

async function setup(stock = 100) {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  if (stock > 0) {
    const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: `sku,quantity,unit,cost\nA,${stock},Piece,1.00` }, idempotencyKey: key() });
    expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  }
  const customer = await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Bilal Wholesale", phone: "0301-1111111" } });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  return { business, product, customerId: customer.body.id as string };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const line = (context: Setup, quantity: string, extra: Record<string, unknown> = {}, unit: "pieceId" | "cartonId" | "packId" = "pieceId") =>
  ({ variantId: context.product.variantId, unitId: context.product[unit], quantity, ...extra });
const stockOf = async (context: Setup) => {
  const found = await callApi(context.business.ownerToken, "GET", "/stock?q=A");
  return found.body.data[0] as { onHand: string; reserved: string; available: string };
};
const orderBody = (context: Setup, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({ customerId: context.customerId, customerPo: "PO-77", lines, ...extra });
const placeOrder = (context: Setup, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  callApi(context.business.ownerToken, "POST", "/sales-orders", { body: orderBody(context, lines, extra), idempotencyKey: key() });
const quote = async (context: Setup, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => {
  const made = await callApi(context.business.ownerToken, "POST", "/quotations", { body: { customerId: context.customerId, validUntil: inDays(14), lines, ...extra } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body;
};
const act = (context: Setup, path: string, body: Record<string, unknown> = {}) => callApi(context.business.ownerToken, "POST", path, { body, idempotencyKey: key() });

integration("sales orders and converting quotations", { timeout: 300_000 }, () => {
  it("acceptance 2: an order reserves stock, so available drops while on hand does not", async () => {
    const context = await setup(100);
    expect(await stockOf(context)).toMatchObject({ onHand: "100", reserved: "0", available: "100" });
    const placed = await placeOrder(context, [line(context, "30")]);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body.order).toMatchObject({ status: "open", customerName: "Bilal Wholesale", customerPo: "PO-77", totalPaisa: 15_000 });
    expect(placed.body.order.number).toMatch(/^SO-[A-Z0-9]+-\d{6}$/);
    expect(placed.body.stock).toEqual([{ variantId: context.product.variantId, onHand: "100", reserved: "30", available: "70" }]);
    expect(await stockOf(context)).toMatchObject({ onHand: "100", reserved: "30", available: "70" });

    // A second order sees only what is left.
    const tooMany = await placeOrder(context, [line(context, "71")]);
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe("STOCK_INSUFFICIENT");
    expect(tooMany.body.error.message).toMatch(/70 available \(100 on hand, 30 already promised/);
    expect(await stockOf(context)).toMatchObject({ reserved: "30" });
    expect((await placeOrder(context, [line(context, "70")])).status).toBe(201);
    expect(await stockOf(context)).toMatchObject({ onHand: "100", reserved: "100", available: "0" });

    // No stock moved: the ledger has only the opening stock.
    const client = sql();
    const [{ moves }] = await client<{ moves: string }[]>`SELECT count(*)::text AS moves FROM stock_ledger WHERE business_id = ${context.business.businessId}`;
    await client.end();
    expect(moves).toBe("1");
  });

  it("cancelling an order lets its stock go; a cancelled order cannot be cancelled again", async () => {
    const context = await setup(100);
    const placed = (await placeOrder(context, [line(context, "40")])).body.order;
    expect(await stockOf(context)).toMatchObject({ reserved: "40" });
    const cancelled = await act(context, `/sales-orders/${placed.id}/cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.order.status).toBe("cancelled");
    expect(cancelled.body.stock[0]).toMatchObject({ reserved: "0", available: "100" });
    expect(await stockOf(context)).toMatchObject({ reserved: "0", available: "100" });
    expect((await act(context, `/sales-orders/${placed.id}/cancel`)).status).toBe(409);
    expect((await act(context, `/sales-orders/${placed.id}/close`)).status).toBe(409);
  });

  it("an order is for a registered customer, is priced at their tier, and cannot be changed afterwards in the database", async () => {
    const context = await setup(100);
    expect((await callApi(context.business.ownerToken, "POST", "/sales-orders", { body: { lines: [line(context, "1")] }, idempotencyKey: key() })).status).toBe(400);
    const placed = (await placeOrder(context, [line(context, "10", { discount: { type: "percent", bps: 1000 } })])).body.order;
    expect(placed).toMatchObject({ lineDiscountPaisa: 500, totalPaisa: 4_500 });
    const client = sql();
    await expect(client`UPDATE sales_order_lines SET unit_price_paisa = 1 WHERE order_id = ${placed.id}`).rejects.toThrow(/cannot be changed/);
    await expect(client`UPDATE sales_orders SET total_paisa = 1 WHERE id = ${placed.id}`).rejects.toThrow(/cannot be changed|violates check/);
    await expect(client`DELETE FROM sales_orders WHERE id = ${placed.id}`).rejects.toThrow(/cannot be deleted/);
    await client.end();
  });

  it("acceptance 1: an accepted quotation converted to an order keeps the quoted prices after the price list changes", async () => {
    const context = await setup(500);
    const made = await quote(context, [line(context, "10"), line(context, "1", {}, "cartonId")]);
    await act(context, `/quotations/${made.id}/send`);
    await act(context, `/quotations/${made.id}/accept`);
    expect(made.totalPaisa).toBe(5_000 + 90_000);

    const client = sql();
    await client`UPDATE product_units SET sale_price_paisa = sale_price_paisa * 2 WHERE variant_id = ${context.product.variantId}`;
    await client.end();

    const converted = await act(context, `/quotations/${made.id}/convert-to-order`, { customerPo: "PO-1" });
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    expect(converted.body.order).toMatchObject({ totalPaisa: 95_000, quotationId: made.id, quotationNumber: made.number, status: "open" });
    expect(converted.body.order.lines.map((row: { unitPricePaisa: number }) => row.unitPricePaisa)).toEqual([500, 90_000]);
  });

  it("converts the whole quotation in one click, marks it converted, and takes it only once", async () => {
    const context = await setup(500);
    const made = await quote(context, [line(context, "10"), line(context, "1", {}, "cartonId")]);
    await act(context, `/quotations/${made.id}/send`);
    const client = sql();
    await client`UPDATE product_units SET sale_price_paisa = sale_price_paisa * 2 WHERE variant_id = ${context.product.variantId}`;
    await client.end();

    const converted = await act(context, `/quotations/${made.id}/convert-to-order`);
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    expect(converted.body.order).toMatchObject({ totalPaisa: 95_000, status: "open" });
    expect(converted.body.order.lines.map((row: { unitPricePaisa: number }) => row.unitPricePaisa)).toEqual([500, 90_000]);
    expect(converted.body.stock[0]).toMatchObject({ reserved: "210", available: "290" });
    expect((await callApi(context.business.ownerToken, "GET", `/quotations/${made.id}`)).body.status).toBe("converted");

    const again = await act(context, `/quotations/${made.id}/convert-to-order`);
    expect(again.status).toBe(409);
  });

  it("converts part of a quotation: some lines, some quantity, at the quoted prices, until nothing is left", async () => {
    const context = await setup(500);
    const made = await quote(context, [line(context, "10", { discount: { type: "percent", bps: 1000 } }), line(context, "4", {}, "packId")]);
    await act(context, `/quotations/${made.id}/send`);
    const [first, second] = made.lines as Array<{ id: string }>;

    // 4 of the 10 pieces: unit price kept, the 10% discount scaled to the quantity.
    const part = await act(context, `/quotations/${made.id}/convert-to-order`, { picks: [{ quotationLineId: first.id, quantity: "4" }] });
    expect(part.status, JSON.stringify(part.body)).toBe(201);
    expect(part.body.order).toMatchObject({ grossPaisa: 2_000, lineDiscountPaisa: 200, totalPaisa: 1_800 });
    expect((await callApi(context.business.ownerToken, "GET", `/quotations/${made.id}`)).body.status).toBe("sent");

    // More than is left on that line is refused.
    const over = await act(context, `/quotations/${made.id}/convert-to-order`, { picks: [{ quotationLineId: first.id, quantity: "7" }] });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("CONVERSION_EXCEEDS_QUOTATION");

    // The rest in one click: 6 pieces and the 4 packs.
    const rest = await act(context, `/quotations/${made.id}/convert-to-order`);
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(rest.body.order.lines.map((row: { quantity: string }) => row.quantity)).toEqual(["6", "4"]);
    expect(rest.body.order.lines[0]).toMatchObject({ grossPaisa: 3_000, lineDiscountPaisa: 300 });
    expect((await callApi(context.business.ownerToken, "GET", `/quotations/${made.id}`)).body).toMatchObject({ status: "converted" });
    // Together the two orders are worth exactly what was quoted.
    expect(part.body.order.totalPaisa + rest.body.order.totalPaisa).toBe(made.totalPaisa);
    expect(await stockOf(context)).toMatchObject({ reserved: "50" }); // 4 + 6 pieces + 4 packs of 10
  });

  it("a prospect's quotation needs a customer to become an order; an expired one cannot", async () => {
    const context = await setup(100);
    const prospect = await callApi(context.business.ownerToken, "POST", "/quotations", { body: { prospectName: "Walk-in", validUntil: inDays(14), lines: [line(context, "5")] } });
    await act(context, `/quotations/${prospect.body.id}/send`);
    const needs = await act(context, `/quotations/${prospect.body.id}/convert-to-order`);
    expect(needs.status).toBe(422);
    expect(needs.body.error.code).toBe("CUSTOMER_REQUIRED");
    const ok = await act(context, `/quotations/${prospect.body.id}/convert-to-order`, { customerId: context.customerId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.order.customerName).toBe("Bilal Wholesale");

    const old = await quote(context, [line(context, "1")]);
    await act(context, `/quotations/${old.id}/send`);
    const client = sql();
    await client.begin(async (tx) => {
      await tx`ALTER TABLE quotations DISABLE TRIGGER quotations_protect`;
      await tx`UPDATE quotations SET quote_date = current_date - 20, valid_until = current_date - 5 WHERE id = ${old.id}`;
      await tx`ALTER TABLE quotations ENABLE TRIGGER quotations_protect`;
    });
    await client.end();
    const expired = await act(context, `/quotations/${old.id}/convert-to-order`);
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe("QUOTATION_EXPIRED");
    // A draft cannot be converted either.
    const draft = await quote(context, [line(context, "1")]);
    expect((await act(context, `/quotations/${draft.id}/convert-to-order`)).status).toBe(409);
  });

  it("the till cannot sell stock that open orders hold, and sells it again once the order is cancelled", async () => {
    const context = await setup(100);
    const placed = (await placeOrder(context, [line(context, "90")])).body.order; // 10 are free
    expect(await stockOf(context)).toMatchObject({ onHand: "100", reserved: "90", available: "10" });
    const shift = await callApi(context.business.ownerToken, "POST", "/shifts/open", { terminalId: context.business.terminalId, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
    const client = sql();
    const [{ id: cashId }] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${context.business.businessId} AND code = 'cash'`;
    await client.end();
    const sell = (quantity: string) => callApi(context.business.ownerToken, "POST", "/sales", {
      terminalId: context.business.terminalId, idempotencyKey: key(),
      body: { shiftId: shift.body.id, lines: [line(context, quantity)], payments: [{ methodId: cashId, amountPaisa: Number(quantity) * 500 }] },
    });
    const refused = await sell("11");
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("STOCK_INSUFFICIENT");
    expect(refused.body.error.message).toMatch(/10 available \(100 on hand, 90 already promised/);
    expect((await sell("10")).status).toBe(201);
    expect(await stockOf(context)).toMatchObject({ onHand: "90", reserved: "90", available: "0" });
    // Cancel the order and the held stock can be sold.
    expect((await act(context, `/sales-orders/${placed.id}/cancel`)).status).toBe(200);
    expect((await sell("50")).status).toBe(201);
    expect(await stockOf(context)).toMatchObject({ onHand: "40", reserved: "0" });
  });

  it("lists orders by status and customer, and keeps cashiers out", async () => {
    const context = await setup(100);
    const a = (await placeOrder(context, [line(context, "5")])).body.order;
    await placeOrder(context, [line(context, "5")]);
    await act(context, `/sales-orders/${a.id}/cancel`);
    const list = (status: string) => callApi(context.business.ownerToken, "GET", `/sales-orders?status=${status}`);
    expect((await list("open")).body.total).toBe(1);
    expect((await list("cancelled")).body.total).toBe(1);
    expect((await list("active")).body.total).toBe(1);
    expect((await callApi(context.business.ownerToken, "GET", "/sales-orders?q=bilal")).body.total).toBe(2);
    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await callApi(cashier.token, "GET", "/sales-orders")).status).toBe(403);
    expect((await callApi(cashier.token, "POST", "/sales-orders", { body: orderBody(context, [line(context, "1")]), idempotencyKey: key() })).status).toBe(403);
  });
});
