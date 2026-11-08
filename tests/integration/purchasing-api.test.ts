// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, firstLocationId, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql, type SimpleProduct } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

// v0.5 slice 2 against the real API and database: purchase orders, goods receipts, stock and average cost.

async function setup(openingStock?: { quantity: number; costRupees: string }) {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  const locationId = await firstLocationId(business);
  if (openingStock) {
    const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: `sku,quantity,unit,cost\nA,${openingStock.quantity},Piece,${openingStock.costRupees}` }, idempotencyKey: key() });
    expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  }
  const supplier = await callApi(business.ownerToken, "POST", "/suppliers", { body: { name: "Karachi Balloon Mills" } });
  expect(supplier.status).toBe(201);
  return { business, product, locationId, supplierId: supplier.body.id as string };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const orderBody = (context: Setup, lines: Array<{ unit?: "pieceId" | "cartonId" | "packId"; quantity: string; cost: number }>, extra: Record<string, unknown> = {}) => ({
  supplierId: context.supplierId, locationId: context.locationId, note: "",
  lines: lines.map((line) => ({ variantId: context.product.variantId, unitId: context.product[line.unit ?? "pieceId"], quantity: line.quantity, unitCostPaisa: line.cost })), ...extra,
});
async function newOrder(context: Setup, lines: Array<{ unit?: "pieceId" | "cartonId" | "packId"; quantity: string; cost: number }>, send = true) {
  const created = await callApi(context.business.ownerToken, "POST", "/purchase-orders", { body: orderBody(context, lines) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  if (send) {
    const sent = await callApi(context.business.ownerToken, "POST", `/purchase-orders/${created.body.id}/send`, { idempotencyKey: key() });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    return sent.body;
  }
  return created.body;
}
const receive = (context: Setup, orderId: string | null, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}, token = context.business.ownerToken) =>
  callApi(token, "POST", "/goods-receipts", { idempotencyKey: key(), body: { supplierId: context.supplierId, locationId: context.locationId, orderId, lines, ...extra } });
const stockOf = async (context: Setup) => {
  const client = sql();
  const [row] = await client<{ on_hand: string; avg_cost_paisa: string }[]>`SELECT on_hand::text, avg_cost_paisa::text FROM stock_balances WHERE variant_id = ${context.product.variantId} AND location_id = ${context.locationId}`;
  await client.end();
  return row ? { onHand: row.on_hand, average: Number(row.avg_cost_paisa) } : { onHand: "0.000", average: 0 };
};
const getOrder = async (context: Setup, id: string) => (await callApi(context.business.ownerToken, "GET", `/purchase-orders/${id}`)).body;

integration("purchase orders and goods receipts", { timeout: 240_000 }, () => {
  it("acceptance 1: an order for 100 received as 60 then 40 completes, and stock goes up by 100", async () => {
    const context = await setup();
    const order = await newOrder(context, [{ quantity: "100", cost: 1_000 }]);
    expect(order).toMatchObject({ status: "sent", totalPaisa: 100_000, supplierName: "Karachi Balloon Mills" });
    expect(order.number).toMatch(/^PO-[A-Z0-9]+-\d{6}$/);
    const lineId = order.lines[0].id as string;

    const first = await receive(context, order.id, [{ orderLineId: lineId, quantity: "60" }], { supplierRef: "DC-4411" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.receipt).toMatchObject({ orderNumber: order.number, supplierRef: "DC-4411", totalPaisa: 60_000 });
    expect(first.body.receipt.number).toMatch(/^GRN-[A-Z0-9]+-\d{6}$/);
    expect(first.body.stock).toEqual([{ variantId: context.product.variantId, onHand: "60", averageCostPaisa: 1_000 }]);
    let current = await getOrder(context, order.id);
    expect(current.status).toBe("partly_received");
    expect(current.lines[0]).toMatchObject({ receivedBase: "60", remainingQuantity: "40" });

    // More than is still to come is refused, and nothing is saved.
    const tooMany = await receive(context, order.id, [{ orderLineId: lineId, quantity: "41" }]);
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe("RECEIPT_EXCEEDS_ORDER");
    expect((await stockOf(context)).onHand).toBe("60.000");

    const second = await receive(context, order.id, [{ orderLineId: lineId, quantity: "40" }]);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    current = await getOrder(context, order.id);
    expect(current.status).toBe("received");
    expect(current.receipts).toHaveLength(2);
    expect((await stockOf(context)).onHand).toBe("100.000");

    // A completed order takes no more, and can be closed.
    const more = await receive(context, order.id, [{ orderLineId: lineId, quantity: "1" }]);
    expect(more.status).toBe(409);
    expect(more.body.error.code).toBe("ORDER_NOT_RECEIVABLE");
    const closed = await callApi(context.business.ownerToken, "POST", `/purchase-orders/${order.id}/close`, { idempotencyKey: key() });
    expect(closed.body.status).toBe("closed");
  });

  it("acceptance 2: a receipt at a new cost updates the average exactly, and the next sale's cost uses it", async () => {
    const context = await setup({ quantity: 100, costRupees: "10.00" });
    expect(await stockOf(context)).toEqual({ onHand: "100.000", average: 1_000 });
    const order = await newOrder(context, [{ quantity: "100", cost: 1_200 }]);
    const lineId = order.lines[0].id as string;
    const received = await receive(context, order.id, [{ orderLineId: lineId, quantity: "100" }]);
    expect(received.status, JSON.stringify(received.body)).toBe(201);
    // (100 x 10.00 + 100 x 12.00) / 200 = 11.00
    expect(await stockOf(context)).toEqual({ onHand: "200.000", average: 1_100 });

    // The next sale takes its cost from the new average.
    const client = sql();
    const [cash] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${context.business.businessId} AND code = 'cash'`;
    await client.end();
    const shift = await callApi(context.business.ownerToken, "POST", "/shifts/open", { terminalId: context.business.terminalId, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
    const sale = await callApi(context.business.ownerToken, "POST", "/sales", {
      terminalId: context.business.terminalId, idempotencyKey: key(),
      body: { shiftId: shift.body.id, customerId: null, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "10" }], payments: [{ methodId: cash.id, amountPaisa: 5_000 }] },
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const reader = sql();
    const [line] = await reader<{ cost_paisa: string }[]>`SELECT cost_paisa::text FROM sales_invoice_lines WHERE invoice_id = ${sale.body.invoice.id}`;
    await reader.end();
    expect(Number(line.cost_paisa)).toBe(1_100);

    // The supplier charged more than the order said: the receipt can carry the real price. (200 x 11.00 + 100 x 14.00) / 300 = 12.00.
    const second = await newOrder(context, [{ quantity: "100", cost: 1_200 }]);
    const dearer = await receive(context, second.id, [{ orderLineId: second.lines[0].id, quantity: "100", unitCostPaisa: 1_400 }]);
    expect(dearer.status, JSON.stringify(dearer.body)).toBe(201);
    expect(dearer.body.receipt.lines[0]).toMatchObject({ unitCostPaisa: 1_400, costPerBasePaisa: 1_400, lineValuePaisa: 140_000 });
    // 190 pieces held at 11.00 (10 were sold) + 100 at 14.00 -> (190 x 1100 + 100 x 1400) / 290 = 1203.45 -> 1203.
    expect(await stockOf(context)).toEqual({ onHand: "290.000", average: 1_203 });
  });

  it("orders in cartons: the quantity, price and stock cost follow the unit", async () => {
    const context = await setup();
    const order = await newOrder(context, [{ unit: "cartonId", quantity: "2", cost: 320_000 }]); // 2 cartons of 200 at Rs 3,200.00
    expect(order.totalPaisa).toBe(640_000);
    expect(order.lines[0]).toMatchObject({ quantity: "2", unitName: "Carton", factorToBase: "200", qtyBase: "400", remainingQuantity: "2" });

    const first = await receive(context, order.id, [{ orderLineId: order.lines[0].id, quantity: "1" }]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.receipt.lines[0]).toMatchObject({ quantity: "1", qtyBase: "200", unitCostPaisa: 320_000, costPerBasePaisa: 1_600, lineValuePaisa: 320_000 });
    expect(await stockOf(context)).toEqual({ onHand: "200.000", average: 1_600 });
    expect((await getOrder(context, order.id)).lines[0]).toMatchObject({ receivedBase: "200", remainingQuantity: "1" });

    // Half a carton is a whole number of pieces, so it can arrive.
    const half = await receive(context, order.id, [{ orderLineId: order.lines[0].id, quantity: "0.5" }]);
    expect(half.status, JSON.stringify(half.body)).toBe(201);
    expect((await stockOf(context)).onHand).toBe("300.000");
  });

  it("receives goods with no order, at the price given", async () => {
    const context = await setup({ quantity: 10, costRupees: "20.00" });
    const direct = await receive(context, null, [{ variantId: context.product.variantId, unitId: context.product.packId, quantity: "5", unitCostPaisa: 25_000 }], { supplierRef: "INV-77" });
    expect(direct.status, JSON.stringify(direct.body)).toBe(201); // 5 packs of 10 at Rs 250.00 = 50 pieces at Rs 25.00
    expect(direct.body.receipt).toMatchObject({ orderId: null, supplierRef: "INV-77", totalPaisa: 125_000 });
    expect(direct.body.receipt.lines[0]).toMatchObject({ qtyBase: "50", costPerBasePaisa: 2_500 });
    // (10 x 20.00 + 50 x 25.00) / 60 = 24.17
    expect(await stockOf(context)).toEqual({ onHand: "60.000", average: 2_417 });

    const unknown = await receive(context, null, [{ variantId: crypto.randomUUID(), unitId: context.product.pieceId, quantity: "1", unitCostPaisa: 100 }]);
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("INVALID_LINE");
    expect((await receive(context, null, [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "1" }])).status).toBe(422); // no price
  });

  it("follows the order's rules: edit a draft, send, cancel, and receive only what was sent", async () => {
    const context = await setup();
    const draft = await newOrder(context, [{ quantity: "10", cost: 500 }], false);
    expect(draft.status).toBe("draft");
    const lineId = draft.lines[0].id as string;

    const early = await receive(context, draft.id, [{ orderLineId: lineId, quantity: "1" }]);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("ORDER_NOT_RECEIVABLE");

    const edited = await callApi(context.business.ownerToken, "PUT", `/purchase-orders/${draft.id}`, { body: orderBody(context, [{ quantity: "20", cost: 600 }, { unit: "packId", quantity: "1", cost: 5_500 }], { expectedDate: "2030-01-31", note: "Rush" }) });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ totalPaisa: 17_500, expectedDate: "2030-01-31", note: "Rush", number: draft.number });
    expect(edited.body.lines.map((line: { lineNo: number }) => line.lineNo)).toEqual([1, 2]);

    await callApi(context.business.ownerToken, "POST", `/purchase-orders/${draft.id}/send`, { idempotencyKey: key() });
    const sentEdit = await callApi(context.business.ownerToken, "PUT", `/purchase-orders/${draft.id}`, { body: orderBody(context, [{ quantity: "1", cost: 1 }]) });
    expect(sentEdit.status).toBe(409);
    expect(sentEdit.body.error.code).toBe("ORDER_NOT_EDITABLE");
    expect((await callApi(context.business.ownerToken, "POST", `/purchase-orders/${draft.id}/send`, { idempotencyKey: key() })).status).toBe(409);

    // Another supplier's receipt cannot be booked against this order.
    const other = await callApi(context.business.ownerToken, "POST", "/suppliers", { body: { name: "Someone Else" } });
    const wrong = await callApi(context.business.ownerToken, "POST", "/goods-receipts", { idempotencyKey: key(), body: { supplierId: other.body.id, locationId: context.locationId, orderId: draft.id, lines: [{ orderLineId: edited.body.lines[0].id, quantity: "1" }] } });
    expect(wrong.status).toBe(422);
    // A line that is not on this order is refused.
    const stranger = await receive(context, draft.id, [{ orderLineId: crypto.randomUUID(), quantity: "1" }]);
    expect(stranger.status).toBe(422);

    // Once something is received it can no longer be cancelled; a sent order with nothing received can.
    await receive(context, draft.id, [{ orderLineId: edited.body.lines[0].id, quantity: "5" }]);
    const cancelPartly = await callApi(context.business.ownerToken, "POST", `/purchase-orders/${draft.id}/cancel`, { idempotencyKey: key() });
    expect(cancelPartly.status).toBe(409);
    const another = await newOrder(context, [{ quantity: "1", cost: 100 }]);
    const cancelled = await callApi(context.business.ownerToken, "POST", `/purchase-orders/${another.id}/cancel`, { idempotencyKey: key() });
    expect(cancelled.body.status).toBe("cancelled");
  });

  it("lists orders and receipts with filters and paging, and keeps a posted receipt immutable", async () => {
    const context = await setup();
    const first = await newOrder(context, [{ quantity: "10", cost: 100 }]);
    await newOrder(context, [{ quantity: "5", cost: 100 }], false);
    const receipt = await receive(context, first.id, [{ orderLineId: first.lines[0].id, quantity: "10" }], { supplierRef: "DC-1" });

    const all = await callApi(context.business.ownerToken, "GET", "/purchase-orders");
    expect(all.body.total).toBe(2);
    expect((await callApi(context.business.ownerToken, "GET", "/purchase-orders?status=draft")).body.total).toBe(1);
    expect((await callApi(context.business.ownerToken, "GET", "/purchase-orders?status=received")).body.total).toBe(1);
    expect((await callApi(context.business.ownerToken, "GET", `/purchase-orders?q=${first.number}`)).body.data.map((row: { id: string }) => row.id)).toEqual([first.id]);
    expect((await callApi(context.business.ownerToken, "GET", "/purchase-orders?pageSize=1&page=2")).body.data).toHaveLength(1);
    expect((await callApi(context.business.ownerToken, "GET", "/purchase-orders/not-an-id")).status).toBe(404);

    const receipts = await callApi(context.business.ownerToken, "GET", "/goods-receipts?q=DC-1");
    expect(receipts.body).toMatchObject({ total: 1, data: [{ number: receipt.body.receipt.number, orderNumber: first.number, totalPaisa: 1_000 }] });
    expect((await callApi(context.business.ownerToken, "GET", `/goods-receipts/${receipt.body.receipt.id}`)).body.lines).toHaveLength(1);
    expect((await callApi(context.business.ownerToken, "GET", `/goods-receipts?orderId=${first.id}`)).body.total).toBe(1);

    const client = sql();
    await expect(client`UPDATE goods_receipts SET note = 'changed' WHERE id = ${receipt.body.receipt.id}`).rejects.toThrow(/cannot be changed/);
    await expect(client`DELETE FROM goods_receipt_lines WHERE receipt_id = ${receipt.body.receipt.id}`).rejects.toThrow(/cannot be changed/);
    await expect(client`UPDATE stock_ledger SET qty_base = 1 WHERE doc_id = ${receipt.body.receipt.id}`).rejects.toThrow();
    await client.end();
  });

  it("replays a retried receipt instead of receiving twice", async () => {
    const context = await setup();
    const order = await newOrder(context, [{ quantity: "10", cost: 100 }]);
    const request = { supplierId: context.supplierId, locationId: context.locationId, orderId: order.id, lines: [{ orderLineId: order.lines[0].id, quantity: "4" }] };
    const requestKey = key();
    const first = await callApi(context.business.ownerToken, "POST", "/goods-receipts", { idempotencyKey: requestKey, body: request });
    const again = await callApi(context.business.ownerToken, "POST", "/goods-receipts", { idempotencyKey: requestKey, body: request });
    expect(first.status).toBe(201);
    expect(again.headers.get("Idempotent-Replay")).toBe("true");
    expect(again.body.receipt.id).toBe(first.body.receipt.id);
    expect((await stockOf(context)).onHand).toBe("4.000");
  });

  it("keeps costs from people who may not see them, and limits who may order and receive", async () => {
    const context = await setup();
    const order = await newOrder(context, [{ quantity: "10", cost: 1_000 }]);
    const lineId = order.lines[0].id as string;

    // A store keeper may see orders and receive goods, but sees no prices and cannot change them.
    const keeper = await inviteStaffWithPermissions(context.business, "Store keeper", ["purchasing.view", "purchasing.receive"]);
    const seen = await callApi(keeper.token, "GET", `/purchase-orders/${order.id}`);
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.body)).not.toMatch(/Cost|Total/);
    expect(seen.body.lines[0]).toMatchObject({ quantity: "10", remainingQuantity: "10" });
    expect(JSON.stringify((await callApi(keeper.token, "GET", "/purchase-orders")).body)).not.toMatch(/totalPaisa/);

    // They receive at the order's price, whatever price they send.
    const received = await receive(context, order.id, [{ orderLineId: lineId, quantity: "4", unitCostPaisa: 9_999 }], {}, keeper.token);
    expect(received.status, JSON.stringify(received.body)).toBe(201);
    expect(JSON.stringify(received.body)).not.toMatch(/Cost|Total/);
    expect(await stockOf(context)).toEqual({ onHand: "4.000", average: 1_000 });
    expect((await receive(context, null, [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "1", unitCostPaisa: 100 }], {}, keeper.token)).status).toBe(403);
    expect((await callApi(keeper.token, "POST", "/purchase-orders", { body: orderBody(context, [{ quantity: "1", cost: 1 }]) })).status).toBe(403);

    // An orderer without the cost permission cannot write prices.
    const orderer = await inviteStaffWithPermissions(context.business, "Orderer", ["purchasing.view", "purchasing.order", "suppliers.view"]);
    expect((await callApi(orderer.token, "POST", "/purchase-orders", { body: orderBody(context, [{ quantity: "1", cost: 1 }]) })).status).toBe(403);

    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await callApi(cashier.token, "GET", "/purchase-orders")).status).toBe(403);
    expect((await callApi(cashier.token, "GET", "/goods-receipts")).status).toBe(403);
    expect((await callApi("", "GET", "/purchase-orders")).status).toBe(401);
  });

  it("refuses a bad order: no items, unknown supplier or location, a non-stock item", async () => {
    const context = await setup();
    const owner = context.business.ownerToken;
    expect((await callApi(owner, "POST", "/purchase-orders", { body: orderBody(context, []) })).status).toBe(400);
    expect((await callApi(owner, "POST", "/purchase-orders", { body: orderBody(context, [{ quantity: "1", cost: 100 }], { supplierId: crypto.randomUUID() }) })).status).toBe(422);
    expect((await callApi(owner, "POST", "/purchase-orders", { body: orderBody(context, [{ quantity: "1", cost: 100 }], { locationId: crypto.randomUUID() }) })).status).toBe(422);
    expect((await callApi(owner, "POST", "/purchase-orders", { body: orderBody(context, [{ quantity: "abc", cost: 100 }]) })).status).toBe(400);
    expect((await callApi(owner, "POST", "/purchase-orders", { body: orderBody(context, [{ quantity: "0", cost: 100 }]) })).status).toBe(400);
    const service: SimpleProduct = await createSimpleProduct(context.business, "SVC", 100, { productType: "service" });
    const refused = await callApi(owner, "POST", "/purchase-orders", {
      body: { supplierId: context.supplierId, locationId: context.locationId, lines: [{ variantId: service.variantId, unitId: service.pieceId, quantity: "1", unitCostPaisa: 100 }] },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("INVALID_LINE");
  });
});

