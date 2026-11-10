// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

// v0.6 slice 4 against the real API and database: delivery challans. Stock leaves on dispatch, not when the challan is written.

async function setup(stock = 100) {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: `sku,quantity,unit,cost\nA,${stock},Piece,1.00` }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const customer = await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Bilal Wholesale", phone: "0301-1111111" } });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  return { business, product, customerId: customer.body.id as string };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const stockOf = async (context: Setup) => (await callApi(context.business.ownerToken, "GET", "/stock?q=A")).body.data[0] as { onHand: string; reserved: string; available: string };
const placeOrder = async (context: Setup, quantity: string, unit: "pieceId" | "cartonId" | "packId" = "pieceId") => {
  const placed = await callApi(context.business.ownerToken, "POST", "/sales-orders", {
    body: { customerId: context.customerId, deliveryAddress: "Shop 9, Jodia Bazaar", lines: [{ variantId: context.product.variantId, unitId: context.product[unit], quantity }] }, idempotencyKey: key(),
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  return placed.body.order as { id: string; lines: Array<{ id: string }> };
};
const challan = (context: Setup, orderId: string, lines?: Array<{ orderLineId: string; quantity: string }>, extra: Record<string, unknown> = {}) =>
  callApi(context.business.ownerToken, "POST", "/delivery-challans", { body: { orderId, ...(lines ? { lines } : {}), ...extra }, idempotencyKey: key() });
const act = (context: Setup, id: string, action: string, body: Record<string, unknown> = {}) =>
  callApi(context.business.ownerToken, "POST", `/delivery-challans/${id}/${action}`, { body, idempotencyKey: key() });
const orderOf = async (context: Setup, id: string) => (await callApi(context.business.ownerToken, "GET", `/sales-orders/${id}`)).body;
const ledgerCount = async (context: Setup, docType: string) => {
  const client = sql();
  const [{ count }] = await client<{ count: string }[]>`SELECT count(*)::text AS count FROM stock_ledger WHERE business_id = ${context.business.businessId} AND doc_type = ${docType}`;
  await client.end();
  return Number(count);
};

integration("delivery challans", { timeout: 300_000 }, () => {
  it("a challan moves no stock until it is dispatched; dispatch takes stock out and moves the order on", async () => {
    const context = await setup(100);
    const order = await placeOrder(context, "30");
    const written = await challan(context, order.id, [{ orderLineId: order.lines[0].id, quantity: "10" }], { driverName: "Rafiq", vehicleNo: "KHI-1234", route: "Saddar" });
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    expect(written.body.challan).toMatchObject({ status: "pending", driverName: "Rafiq", vehicleNo: "KHI-1234", route: "Saddar", deliveryAddress: "Shop 9, Jodia Bazaar" });
    expect(written.body.challan.number).toMatch(/^DC-[A-Z0-9]+-\d{6}$/);
    expect(await stockOf(context)).toMatchObject({ onHand: "100", reserved: "30", available: "70" });
    expect(await ledgerCount(context, "delivery_challan")).toBe(0);

    // Dispatch: stock leaves (100 -> 90), 20 are still held, the order is partly delivered.
    const sent = await act(context, written.body.challan.id, "dispatch", { driverName: "Rafiq D." });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.challan).toMatchObject({ status: "dispatched", driverName: "Rafiq D." });
    expect(sent.body.stock).toEqual([{ variantId: context.product.variantId, onHand: "90", reserved: "20", available: "70" }]);
    expect(await stockOf(context)).toMatchObject({ onHand: "90", reserved: "20", available: "70" });
    expect(await ledgerCount(context, "delivery_challan")).toBe(1);
    let current = await orderOf(context, order.id);
    expect(current.status).toBe("partly_delivered");
    expect(current.lines[0]).toMatchObject({ deliveredBase: "10", remainingBase: "20", unassignedBase: "20" });
    expect(current.challans).toHaveLength(1);

    // Dispatched twice is refused; delivered is a later step.
    expect((await act(context, written.body.challan.id, "dispatch")).status).toBe(409);
    expect((await act(context, written.body.challan.id, "deliver")).body.challan.status).toBe("delivered");

    // The rest goes in one click (no lines named): the order is delivered and holds nothing.
    const rest = await challan(context, order.id);
    expect(rest.body.challan.lines.map((line: { quantity: string }) => line.quantity)).toEqual(["20"]);
    expect((await act(context, rest.body.challan.id, "dispatch")).status).toBe(200);
    expect(await stockOf(context)).toMatchObject({ onHand: "70", reserved: "0", available: "70" });
    current = await orderOf(context, order.id);
    expect(current.status).toBe("delivered");
    // A delivered order takes no more challans; it can be closed.
    expect((await challan(context, order.id)).status).toBe(409);
    expect((await callApi(context.business.ownerToken, "POST", `/sales-orders/${order.id}/close`, { idempotencyKey: key() })).status).toBe(200);
  });

  it("cannot carry more than the order has left, counting what other pending challans already carry", async () => {
    const context = await setup(100);
    const order = await placeOrder(context, "30");
    const line = order.lines[0].id;
    expect((await challan(context, order.id, [{ orderLineId: line, quantity: "31" }])).status).toBe(409);
    const first = await challan(context, order.id, [{ orderLineId: line, quantity: "20" }]);
    expect(first.status).toBe(201);
    const second = await challan(context, order.id, [{ orderLineId: line, quantity: "11" }]);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("DELIVERY_EXCEEDS_ORDER");
    expect((await challan(context, order.id, [{ orderLineId: line, quantity: "10" }])).status).toBe(201);
    // Cancelling the first frees its quantity again.
    expect((await act(context, first.body.challan.id, "cancel")).body.challan.status).toBe("cancelled");
    expect((await challan(context, order.id, [{ orderLineId: line, quantity: "20" }])).status).toBe(201);
    // A line of another order is refused.
    const other = await placeOrder(context, "5");
    expect((await challan(context, order.id, [{ orderLineId: other.lines[0].id, quantity: "1" }])).status).toBe(422);
  });

  it("carries cartons as ordered and takes the base quantity out of stock", async () => {
    const context = await setup(500);
    const order = await placeOrder(context, "2", "cartonId"); // 2 cartons = 400 pieces
    expect(await stockOf(context)).toMatchObject({ reserved: "400" });
    const written = await challan(context, order.id, [{ orderLineId: order.lines[0].id, quantity: "1" }]);
    expect(written.body.challan.lines[0]).toMatchObject({ quantity: "1", qtyBase: "200", unitName: "Carton" });
    await act(context, written.body.challan.id, "dispatch");
    expect(await stockOf(context)).toMatchObject({ onHand: "300", reserved: "200" });
  });

  it("returned goods go back into stock at the cost they left at, and the order holds them again", async () => {
    const context = await setup(100);
    const order = await placeOrder(context, "30");
    const written = await challan(context, order.id);
    await act(context, written.body.challan.id, "dispatch");
    expect(await stockOf(context)).toMatchObject({ onHand: "70", reserved: "0" });
    expect((await orderOf(context, order.id)).status).toBe("delivered");

    const noReason = await act(context, written.body.challan.id, "return", {});
    expect(noReason.status).toBe(400);
    const back = await act(context, written.body.challan.id, "return", { reason: "Customer refused the delivery" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.challan).toMatchObject({ status: "returned", returnReason: "Customer refused the delivery" });
    expect(await stockOf(context)).toMatchObject({ onHand: "100", reserved: "30", available: "70" });
    expect(await ledgerCount(context, "delivery_return")).toBe(1);
    const current = await orderOf(context, order.id);
    expect(current.status).toBe("open");
    expect(current.lines[0]).toMatchObject({ deliveredBase: "0", unassignedBase: "30" });
    // Average cost was not disturbed (cost Re 1.00 each way).
    const client = sql();
    const [balance] = await client<{ avg_cost_paisa: string }[]>`SELECT avg_cost_paisa::text FROM stock_balances WHERE variant_id = ${context.product.variantId}`;
    await client.end();
    expect(balance.avg_cost_paisa).toBe("100");
    // It cannot be returned twice, and the order can be delivered again with a new challan.
    expect((await act(context, written.body.challan.id, "return", { reason: "again" })).status).toBe(409);
    expect((await challan(context, order.id)).status).toBe(201);
  });

  it("refuses to dispatch what is not on the shelf, and nothing is saved", async () => {
    const context = await setup(100);
    const order = await placeOrder(context, "30");
    // 90 of the reserved 100 are sold some other way (a stock adjustment), leaving 10 on the shelf.
    const client = sql();
    const [{ id: locationId }] = await client<{ id: string }[]>`SELECT location_id AS id FROM stock_balances WHERE variant_id = ${context.product.variantId}`;
    await client`INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, unit_cost_paisa, doc_type, doc_id) VALUES (${context.business.businessId}, ${context.product.variantId}, ${locationId}, -90, 100, 'test_removal', gen_random_uuid())`;
    await client.end();
    const written = await challan(context, order.id);
    const sent = await act(context, written.body.challan.id, "dispatch");
    expect(sent.status).toBe(409);
    expect(sent.body.error.code).toBe("STOCK_INSUFFICIENT");
    expect(sent.body.error.message).toMatch(/10 on hand, 30 needed/);
    expect((await callApi(context.business.ownerToken, "GET", `/delivery-challans/${written.body.challan.id}`)).body.status).toBe("pending");
    expect((await orderOf(context, order.id)).status).toBe("open");
    expect(await ledgerCount(context, "delivery_challan")).toBe(0);
  });

  it("answers a request with no readable body with 400, not a server error", async () => {
    const context = await setup(100);
    const order = await placeOrder(context, "5");
    const written = await challan(context, order.id);
    const noBody = await callApi(context.business.ownerToken, "POST", `/delivery-challans/${written.body.challan.id}/dispatch`, { idempotencyKey: key() });
    expect(noBody.status).toBe(400);
    expect(noBody.body.error.code).toBe("BAD_REQUEST");
    // Nothing happened; the same request with a body works.
    expect((await act(context, written.body.challan.id, "dispatch")).status).toBe(200);
  });

  it("cancelling an order takes its pending challans with it, and a cancelled challan cannot be dispatched", async () => {
    const context = await setup(100);
    const order = await placeOrder(context, "30");
    const written = await challan(context, order.id);
    expect((await callApi(context.business.ownerToken, "POST", `/sales-orders/${order.id}/cancel`, { idempotencyKey: key() })).status).toBe(200);
    expect((await callApi(context.business.ownerToken, "GET", `/delivery-challans/${written.body.challan.id}`)).body.status).toBe("cancelled");
    expect((await act(context, written.body.challan.id, "dispatch")).status).toBe(409);
    expect(await stockOf(context)).toMatchObject({ onHand: "100", reserved: "0" });
  });

  it("lists challans, protects them in the database, and keeps cashiers out", async () => {
    const context = await setup(100);
    const order = await placeOrder(context, "30");
    const written = await challan(context, order.id, undefined, { vehicleNo: "KHI-9" });
    expect((await callApi(context.business.ownerToken, "GET", "/delivery-challans?status=pending")).body.total).toBe(1);
    expect((await callApi(context.business.ownerToken, "GET", "/delivery-challans?status=active")).body.total).toBe(1);
    expect((await callApi(context.business.ownerToken, "GET", "/delivery-challans?q=khi-9")).body.total).toBe(1);
    expect((await callApi(context.business.ownerToken, "GET", "/delivery-challans?status=delivered")).body.total).toBe(0);
    const client = sql();
    await expect(client`UPDATE delivery_challan_lines SET qty_entered = 1, qty_base = 1 WHERE challan_id = ${written.body.challan.id}`).rejects.toThrow(/cannot be changed/);
    await expect(client`DELETE FROM delivery_challans WHERE id = ${written.body.challan.id}`).rejects.toThrow(/cannot be deleted/);
    await client.end();
    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await callApi(cashier.token, "GET", "/delivery-challans")).status).toBe(403);
    expect((await callApi(cashier.token, "POST", `/delivery-challans/${written.body.challan.id}/dispatch`, { idempotencyKey: key() })).status).toBe(403);
  });
});
