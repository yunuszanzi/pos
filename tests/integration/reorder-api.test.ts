// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, firstLocationId, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const today = () => new Date().toISOString().slice(0, 10);

// v0.5 slice 5 against the real API and database: the reorder list, draft orders per supplier, and what a SKU cost last time.

async function setup() {
  const business = await createTestBusiness();
  const locationId = await firstLocationId(business);
  const products = {
    a: await createSimpleProduct(business, "A", 500),
    b: await createSimpleProduct(business, "B", 500),
    c: await createSimpleProduct(business, "C", 500),
    d: await createSimpleProduct(business, "D", 500),
    e: await createSimpleProduct(business, "E", 500),
  };
  // Reorder levels and quantities are set on the SKU.
  const client = sql();
  const level = async (variantId: string, reorderLevel: string, reorderQuantity: string) =>
    client`UPDATE product_variants SET reorder_level = ${reorderLevel}, reorder_quantity = ${reorderQuantity} WHERE id = ${variantId}`;
  await level(products.a.variantId, "50", "200");
  await level(products.b.variantId, "100", "0");
  await level(products.c.variantId, "0", "0");
  await level(products.d.variantId, "100", "0");
  await level(products.e.variantId, "50", "0");
  await client.end();
  const supplier = async (name: string) => (await callApi(business.ownerToken, "POST", "/suppliers", { body: { name } })).body.id as string;
  const [first, second] = [await supplier("Karachi Balloon Mills"), await supplier("Lahore Packaging")];
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", {
    idempotencyKey: key(), body: { csv: "sku,quantity,unit,cost\nB,30,Piece,5.00\nC,5,Piece,5.00\nD,200,Piece,5.00\nE,10,Piece,5.00" },
  });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  return { business, locationId, products, first, second };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const reorderList = async (context: Setup, query = "", token = context.business.ownerToken) => callApi(token, "GET", `/reorder-list${query}`);
const names = (body: { data: Array<{ sku: string }> }) => body.data.map((row) => row.sku);

/** Receives `quantity` pieces of A from a supplier at a price, so that supplier and price become what A last cost. */
async function receiveA(context: Setup, supplierId: string, quantity: string, costPaisa: number) {
  const posted = await callApi(context.business.ownerToken, "POST", "/goods-receipts", {
    idempotencyKey: key(),
    body: { supplierId, locationId: context.locationId, lines: [{ variantId: context.products.a.variantId, unitId: context.products.a.pieceId, quantity, unitCostPaisa: costPaisa }] },
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(201);
  return posted.body.receipt;
}

integration("the reorder list and purchase history", { timeout: 240_000 }, () => {
  it("lists what is at or below its reorder level, most short first, with the quantity to order", async () => {
    const context = await setup();
    await receiveA(context, context.first, "10", 1_200); // A: 10 on hand, last bought from the first supplier at Rs 12.00

    // An order on its way covers E, so it drops off the list.
    const sent = await callApi(context.business.ownerToken, "POST", "/purchase-orders", {
      body: { supplierId: context.first, locationId: context.locationId, lines: [{ variantId: context.products.e.variantId, unitId: context.products.e.pieceId, quantity: "100", unitCostPaisa: 500 }] },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect((await reorderList(context)).body.data.map((row: { sku: string }) => row.sku)).toContain("E"); // a draft is not on its way yet
    await callApi(context.business.ownerToken, "POST", `/purchase-orders/${sent.body.id}/send`, { idempotencyKey: key() });

    const list = await reorderList(context);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    // B is further below its level (30 of 100) than A (10 of 50); C has no level, D has plenty, E is covered by its order.
    expect(names(list.body)).toEqual(["B", "A"]);
    expect(list.body.total).toBe(2);
    expect(list.body.data[0]).toMatchObject({ sku: "B", onHand: "30", onOrder: "0", reorderLevel: "100", suggestedQuantity: "70", baseUnitName: "Piece", supplier: null });
    expect(list.body.data[1]).toMatchObject({
      sku: "A", onHand: "10", reorderLevel: "50", suggestedQuantity: "200", lastCostPerBasePaisa: 1_200,
      supplier: { id: context.first, name: "Karachi Balloon Mills", preferred: false },
    });

    expect(names((await reorderList(context, "?q=product%20b")).body)).toEqual(["B"]);
    const page = await reorderList(context, "?pageSize=1&page=2");
    expect(names(page.body)).toEqual(["A"]);
    expect(page.body.total).toBe(2);
  });

  it("turns chosen lines into one draft order per supplier, and remembers the supplier a SKU is bought from", async () => {
    const context = await setup();
    await receiveA(context, context.first, "10", 1_200);
    const request = {
      locationId: context.locationId,
      lines: [
        { variantId: context.products.a.variantId, supplierId: context.first, quantity: "200", remember: true },
        { variantId: context.products.b.variantId, supplierId: context.second, quantity: "70" },
      ],
    };
    const requestKey = key();
    const made = await callApi(context.business.ownerToken, "POST", "/reorder-list/draft-orders", { idempotencyKey: requestKey, body: request });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const byName = Object.fromEntries(made.body.orders.map((entry: { supplierName: string }) => [entry.supplierName, entry]));
    // A last cost Rs 12.00 a piece; B was never bought, so its own cost (Rs 5.00) is used.
    expect(byName["Karachi Balloon Mills"]).toMatchObject({ lineCount: 1, totalPaisa: 240_000 });
    expect(byName["Lahore Packaging"]).toMatchObject({ lineCount: 1, totalPaisa: 35_000 });

    const order = await callApi(context.business.ownerToken, "GET", `/purchase-orders/${byName["Karachi Balloon Mills"].id}`);
    expect(order.body).toMatchObject({ status: "draft", note: "From the reorder list", locationId: context.locationId, totalPaisa: 240_000 });
    expect(order.body.lines[0]).toMatchObject({ sku: "A", unitName: "Piece", quantity: "200", unitCostPaisa: 1_200 });

    // A retried request replays instead of making the orders twice.
    const replay = await callApi(context.business.ownerToken, "POST", "/reorder-list/draft-orders", { idempotencyKey: requestKey, body: request });
    expect(replay.headers.get("Idempotent-Replay")).toBe("true");
    expect((await callApi(context.business.ownerToken, "GET", "/purchase-orders?status=draft")).body.total).toBe(2);

    // A is now bought from the first supplier by choice; B's supplier was not remembered.
    const list = (await reorderList(context)).body;
    expect(list.data.find((row: { sku: string }) => row.sku === "A").supplier).toEqual({ id: context.first, name: "Karachi Balloon Mills", preferred: true });
    expect(list.data.find((row: { sku: string }) => row.sku === "B").supplier).toBeNull();

    // Once the order is sent, A is covered and leaves the list.
    await callApi(context.business.ownerToken, "POST", `/purchase-orders/${byName["Karachi Balloon Mills"].id}/send`, { idempotencyKey: key() });
    const after = (await reorderList(context)).body;
    expect(names(after)).toEqual(["B", "E"]); // E is also low, and nothing is on its way
  });

  it("refuses a bad request and checks permissions", async () => {
    const context = await setup();
    const line = { variantId: context.products.b.variantId, supplierId: context.first, quantity: "10" };
    const post = (body: Record<string, unknown>, token = context.business.ownerToken) => callApi(token, "POST", "/reorder-list/draft-orders", { idempotencyKey: key(), body });
    expect((await post({ locationId: context.locationId, lines: [] })).status).toBe(400);
    expect((await post({ locationId: context.locationId, lines: [{ ...line, quantity: "abc" }] })).status).toBe(400);
    expect((await post({ locationId: context.locationId, lines: [line, line] })).status).toBe(422);
    expect((await post({ locationId: context.locationId, lines: [{ ...line, supplierId: crypto.randomUUID() }] })).status).toBe(422);
    expect((await post({ locationId: crypto.randomUUID(), lines: [line] })).status).toBe(422);
    expect((await post({ locationId: context.locationId, lines: [{ ...line, variantId: crypto.randomUUID() }] })).status).toBe(422);
    expect((await callApi(context.business.ownerToken, "GET", "/purchase-orders")).body.total).toBe(0); // nothing was half made

    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await reorderList(context, "", cashier.token)).status).toBe(403);
    expect((await post({ locationId: context.locationId, lines: [line] }, cashier.token)).status).toBe(403);
    // Someone who may see the list but not costs sees no costs, and cannot make orders.
    const viewer = await inviteStaffWithPermissions(context.business, "Stock viewer", ["purchasing.view"]);
    const seen = await reorderList(context, "", viewer.token);
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.body)).not.toMatch(/Cost/);
    expect((await post({ locationId: context.locationId, lines: [line] }, viewer.token)).status).toBe(403);
    expect((await callApi("", "GET", "/reorder-list")).status).toBe(401);
  });

  it("remembers what a SKU cost last time: the billed price once there is a bill", async () => {
    const context = await setup();
    const variantId = context.products.a.variantId;
    expect((await callApi(context.business.ownerToken, "GET", `/purchase-history/${variantId}`)).body).toEqual({ lastCostPerBasePaisa: null, entries: [] });

    const first = await receiveA(context, context.first, "10", 1_000);
    const second = await receiveA(context, context.second, "20", 1_100);
    let history = (await callApi(context.business.ownerToken, "GET", `/purchase-history/${variantId}`)).body;
    expect(history.lastCostPerBasePaisa).toBe(1_100);
    expect(history.entries.map((row: { receiptNumber: string; supplierName: string; unitCostPaisa: number; billed: boolean }) => [row.receiptNumber, row.supplierName, row.unitCostPaisa, row.billed])).toEqual([
      [second.number, "Lahore Packaging", 1_100, false], [first.number, "Karachi Balloon Mills", 1_000, false],
    ]);

    // The supplier then bills the second delivery at Rs 13.00: that is what it really cost.
    const bill = await callApi(context.business.ownerToken, "POST", "/purchase-bills", {
      idempotencyKey: key(),
      body: { supplierId: context.second, supplierInvoiceNo: "LP-1", billDate: today(), lines: [{ receiptLineId: second.lines[0].id, quantity: "20", unitCostPaisa: 1_300 }] },
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    history = (await callApi(context.business.ownerToken, "GET", `/purchase-history/${variantId}`)).body;
    expect(history.lastCostPerBasePaisa).toBe(1_300);
    expect(history.entries[0]).toMatchObject({ unitCostPaisa: 1_300, billed: true, costPerBasePaisa: 1_300 });

    // Five at most, newest first.
    for (let index = 0; index < 5; index += 1) await receiveA(context, context.first, "1", 900 + index);
    history = (await callApi(context.business.ownerToken, "GET", `/purchase-history/${variantId}`)).body;
    expect(history.entries).toHaveLength(5);
    expect(history.entries[0].unitCostPaisa).toBe(904);

    const keeper = await inviteStaffWithPermissions(context.business, "Keeper", ["purchasing.view"]);
    expect((await callApi(keeper.token, "GET", `/purchase-history/${variantId}`)).status).toBe(403);
    expect((await callApi(context.business.ownerToken, "GET", "/purchase-history/not-an-id")).body).toEqual({ lastCostPerBasePaisa: null, entries: [] });
  });
});
