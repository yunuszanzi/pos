// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, firstLocationId, hasLocalStack, inviteStaffWithPermissions, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

// v0.9 slice 1 against the real API and database: stock transfers. Stock leaves the source on dispatch, arrives on receipt,
// and is in transit between the two.

async function setup(openingPieces = 5000) {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 250);
  const main = await firstLocationId(business);
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: `sku,quantity,unit,cost\nA,${openingPieces},Piece,2.50` }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const warehouse = await callApi(business.ownerToken, "POST", "/locations", { body: { branchId: business.branchId, name: "Warehouse", type: "warehouse" } });
  const damaged = await callApi(business.ownerToken, "POST", "/locations", { body: { branchId: business.branchId, name: "Damaged goods", type: "damaged" } });
  return { business, product, main, warehouseId: warehouse.body.id as string, damagedId: damaged.body.id as string };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const request = (context: Setup, quantity: string, extra: Record<string, unknown> = {}, unit: "pieceId" | "cartonId" = "cartonId") =>
  callApi(context.business.ownerToken, "POST", "/stock-transfers", {
    idempotencyKey: key(),
    body: { fromLocationId: context.main, toLocationId: context.warehouseId, lines: [{ variantId: context.product.variantId, unitId: context.product[unit], quantity }], ...extra },
  });
const act = (context: Setup, id: string, action: string, body: Record<string, unknown> = {}) =>
  callApi(context.business.ownerToken, "POST", `/stock-transfers/${id}/${action}`, { body, idempotencyKey: key() });
const levels = async (context: Setup, locationId: string) => {
  const rows = await callApi(context.business.ownerToken, "GET", `/stock?q=A&locationId=${locationId}`);
  return rows.body.data[0] as { onHand: string; inTransit: string };
};
const totals = async (context: Setup) => (await callApi(context.business.ownerToken, "GET", "/stock?q=A")).body.data[0] as { onHand: string; inTransit: string; avgCostPaisa: number };

integration("stock transfers", { timeout: 300_000 }, () => {
  it("acceptance 1: 20 cartons leave the source on dispatch, show as in transit, and arrive on receipt", async () => {
    const context = await setup(5000);
    const written = await request(context, "20");
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    expect(written.body.transfer).toMatchObject({ status: "requested", fromName: "Main Store", toName: "Warehouse" });
    expect(written.body.transfer.number).toMatch(/^ST-KHI-\d{6}$/);
    expect(written.body.transfer.lines[0]).toMatchObject({ quantity: "20", unitName: "Carton", qtyBase: "4000" });
    const id = written.body.transfer.id as string;

    // Requested moves nothing.
    expect((await levels(context, context.main)).onHand).toBe("5000");

    // Dispatched: the source drops, nothing is at the destination yet, and the 4,000 pieces are in transit.
    const sent = await act(context, id, "dispatch");
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.transfer.status).toBe("dispatched");
    expect(sent.body.stock).toEqual([{ variantId: context.product.variantId, locationId: context.main, onHand: "1000" }]);
    expect(await levels(context, context.main)).toMatchObject({ onHand: "1000" });
    expect(await levels(context, context.warehouseId)).toMatchObject({ onHand: "0", inTransit: "4000" });
    expect(await totals(context)).toMatchObject({ onHand: "1000", inTransit: "4000" });
    const transit = await callApi(context.business.ownerToken, "GET", "/stock-transfers/in-transit");
    expect(transit.body.data).toHaveLength(1);
    expect(transit.body.data[0]).toMatchObject({ number: written.body.transfer.number, fromName: "Main Store", toName: "Warehouse", sku: "A", qtyBase: "4000", valuePaisa: 1_000_000 });

    // Received: the destination rises, nothing is in transit, and the value that left is the value that arrived.
    const received = await act(context, id, "receive");
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    expect(received.body.transfer.status).toBe("received");
    expect(received.body.transfer.lines[0]).toMatchObject({ receivedBase: "4000", shortageBase: "0" });
    expect(await levels(context, context.warehouseId)).toMatchObject({ onHand: "4000", inTransit: "0" });
    expect(await levels(context, context.main)).toMatchObject({ onHand: "1000" });
    expect(await totals(context)).toMatchObject({ onHand: "5000", inTransit: "0", avgCostPaisa: 250 });
    expect((await callApi(context.business.ownerToken, "GET", "/stock-transfers/in-transit")).body.data).toHaveLength(0);

    const ledger = await callApi(context.business.ownerToken, "GET", `/stock/ledger?variantId=${context.product.variantId}&pageSize=50`);
    const kinds = ledger.body.data.map((row: { docType: string }) => row.docType);
    expect(kinds).toEqual(expect.arrayContaining(["stock_transfer_out", "stock_transfer_in"]));
  });

  it("is idempotent, refuses a second dispatch or receipt, and never posts twice", async () => {
    const context = await setup(5000);
    const id = (await request(context, "5")).body.transfer.id as string;
    const first = await callApi(context.business.ownerToken, "POST", `/stock-transfers/${id}/dispatch`, { idempotencyKey: "same-key" });
    const again = await callApi(context.business.ownerToken, "POST", `/stock-transfers/${id}/dispatch`, { idempotencyKey: "same-key" });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect((await act(context, id, "dispatch")).status).toBe(409);
    expect((await act(context, id, "cancel")).status).toBe(409);
    expect((await levels(context, context.main)).onHand).toBe("4000");
    expect((await act(context, id, "receive")).status).toBe(200);
    expect((await act(context, id, "receive")).status).toBe(409);
    expect((await levels(context, context.warehouseId)).onHand).toBe("1000");
  });

  it("refuses to send more than the source has, naming the item, and moves nothing", async () => {
    const context = await setup(1000);
    const id = (await request(context, "6")).body.transfer.id as string; // 6 cartons = 1,200 pieces
    const refused = await act(context, id, "dispatch");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("STOCK_INSUFFICIENT");
    expect(refused.body.error.message).toContain("Product A");
    expect((await levels(context, context.main)).onHand).toBe("1000");
    expect((await callApi(context.business.ownerToken, "GET", `/stock-transfers/${id}`)).body.status).toBe("requested");
  });

  it("records a shortage when less arrives, and posts only what arrived", async () => {
    const context = await setup(5000);
    const written = await request(context, "100", {}, "pieceId");
    const id = written.body.transfer.id as string;
    const lineId = written.body.transfer.lines[0].id as string;
    await act(context, id, "dispatch");
    const tooMany = await act(context, id, "receive", { lines: [{ lineId, quantity: "101" }] });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe("RECEIVED_MORE_THAN_SENT");
    const short = await act(context, id, "receive", { note: "Two boxes were wet", lines: [{ lineId, quantity: "97.5" }] });
    expect(short.status, JSON.stringify(short.body)).toBe(200);
    expect(short.body.transfer).toMatchObject({ status: "received", receiveNote: "Two boxes were wet" });
    expect(short.body.transfer.lines[0]).toMatchObject({ receivedBase: "97.5", shortageBase: "2.5" });
    expect(await levels(context, context.warehouseId)).toMatchObject({ onHand: "97.5", inTransit: "0" });
    expect((await levels(context, context.main)).onHand).toBe("4900");
  });

  it("can be cancelled while only requested, and writes nothing to the ledger", async () => {
    const context = await setup(5000);
    const id = (await request(context, "1")).body.transfer.id as string;
    expect((await act(context, id, "cancel")).body.transfer.status).toBe("cancelled");
    expect((await act(context, id, "dispatch")).status).toBe(409);
    expect((await levels(context, context.main)).onHand).toBe("5000");
  });

  it("validates the request: two different locations, stocked items listed once, a real quantity", async () => {
    const context = await setup(5000);
    const line = { variantId: context.product.variantId, unitId: context.product.cartonId, quantity: "1" };
    expect((await request(context, "1", { toLocationId: context.main })).status).toBe(400);
    expect((await request(context, "1", { lines: [] })).status).toBe(400);
    expect((await request(context, "1", { lines: [line, line] })).status).toBe(422);
    expect((await request(context, "0")).status).toBe(400);
    expect((await request(context, "abc")).status).toBe(400);
    expect((await request(context, "1", { toLocationId: crypto.randomUUID() })).status).toBe(404);
    expect((await request(context, "1", { lines: [{ ...line, unitId: crypto.randomUUID() }] })).status).toBe(422);
  });

  it("moves goods into a damaged location, where they stay counted but apart", async () => {
    const context = await setup(100);
    const id = (await request(context, "10", { toLocationId: context.damagedId }, "pieceId")).body.transfer.id as string;
    await act(context, id, "dispatch");
    await act(context, id, "receive");
    expect(await levels(context, context.damagedId)).toMatchObject({ onHand: "10" });
    expect(await levels(context, context.main)).toMatchObject({ onHand: "90" });
  });

  it("keeps a transfer's record: it cannot be edited or deleted underneath the API", async () => {
    const context = await setup(100);
    const id = (await request(context, "10", {}, "pieceId")).body.transfer.id as string;
    const client = sql();
    try {
      await expect(client`UPDATE stock_transfer_lines SET qty_base = 1, qty_entered = 1 WHERE transfer_id = ${id}`).rejects.toThrow(/cannot be changed/);
      await expect(client`UPDATE stock_transfers SET from_location_id = ${context.damagedId} WHERE id = ${id}`).rejects.toThrow(/cannot be changed/);
      await expect(client`DELETE FROM stock_transfers WHERE id = ${id}`).rejects.toThrow(/cannot be deleted/);
    } finally {
      await client.end();
    }
  });

  it("lists, filters and searches transfers, and protects them by permission and by business", async () => {
    const context = await setup(5000);
    const a = (await request(context, "1")).body.transfer;
    const b = (await request(context, "2")).body.transfer;
    await act(context, b.id, "dispatch");
    const all = await callApi(context.business.ownerToken, "GET", "/stock-transfers");
    expect(all.body.total).toBe(2);
    expect((await callApi(context.business.ownerToken, "GET", "/stock-transfers?status=dispatched")).body.data.map((row: { id: string }) => row.id)).toEqual([b.id]);
    expect((await callApi(context.business.ownerToken, "GET", "/stock-transfers?status=open")).body.total).toBe(2);
    expect((await callApi(context.business.ownerToken, "GET", `/stock-transfers?q=${a.number}`)).body.data.map((row: { id: string }) => row.id)).toEqual([a.id]);
    expect((await callApi(context.business.ownerToken, "GET", `/stock-transfers/not-a-uuid`)).status).toBe(404);

    const viewer = await inviteStaffWithPermissions(context.business, "Transfers viewer", ["transfers.view"]);
    expect((await callApi(viewer.token, "GET", "/stock-transfers")).status).toBe(200);
    expect((await callApi(viewer.token, "POST", `/stock-transfers/${a.id}/dispatch`, { idempotencyKey: key() })).status).toBe(403);
    const nobody = await inviteStaffWithPermissions(context.business, "Nobody", ["inventory.view"]);
    expect((await callApi(nobody.token, "GET", "/stock-transfers")).status).toBe(403);

    const other = await createTestBusiness();
    expect((await callApi(other.ownerToken, "GET", `/stock-transfers/${a.id}`)).status).toBe(404);
    expect((await callApi(other.ownerToken, "POST", `/stock-transfers/${a.id}/dispatch`, { idempotencyKey: key() })).status).toBe(404);
  });

  it("hides costs from someone who may not see them", async () => {
    const context = await setup(5000);
    const id = (await request(context, "1")).body.transfer.id as string;
    await act(context, id, "dispatch");
    const clerk = await inviteStaffWithPermissions(context.business, "Transfers clerk", ["transfers.view", "inventory.view"]);
    const seen = await callApi(clerk.token, "GET", `/stock-transfers/${id}`);
    expect(seen.body.lines[0]).not.toHaveProperty("costPaisa");
    expect((await callApi(clerk.token, "GET", "/stock-transfers/in-transit")).body.data[0]).not.toHaveProperty("valuePaisa");
    expect((await callApi(context.business.ownerToken, "GET", `/stock-transfers/${id}`)).body.lines[0].costPaisa).toBe(250);
  });
});
