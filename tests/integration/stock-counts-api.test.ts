// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, firstLocationId, hasLocalStack, inviteStaffWithPermissions, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

// v0.9 slice 2 against the real API and database: physical stock counts. The books' figure is frozen at the start, people count,
// the variance is reviewed, and approving posts one adjustment.

async function setup() {
  const business = await createTestBusiness();
  const a = await createSimpleProduct(business, "A", 100);
  const b = await createSimpleProduct(business, "B", 200);
  const c = await createSimpleProduct(business, "C", 300);
  const main = await firstLocationId(business);
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,100,Piece,1.00\nB,50,Piece,2.00\nC,10,Piece,3.00" }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  return { business, a, b, c, main };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const start = (context: Setup, body: Record<string, unknown> = {}) =>
  callApi(context.business.ownerToken, "POST", "/stock-counts", { idempotencyKey: key(), body: { locationId: context.main, scope: "full", ...body } });
const enter = (context: Setup, id: string, entries: Array<{ variantId: string; unitId: string; quantity: string }>, mode = "set") =>
  callApi(context.business.ownerToken, "POST", `/stock-counts/${id}/entries`, { body: { mode, entries } });
const act = (context: Setup, id: string, action: string, body: Record<string, unknown> = {}) =>
  callApi(context.business.ownerToken, "POST", `/stock-counts/${id}/${action}`, { body, idempotencyKey: key() });
const onHand = async (context: Setup, sku: string) => (await callApi(context.business.ownerToken, "GET", "/stock?pageSize=100")).body.data.find((row: { sku: string }) => row.sku === sku).onHand as string;
const line = (count: { lines: { data: Array<{ sku: string }> } }, sku: string) => count.lines.data.find((row) => row.sku === sku) as Record<string, unknown>;

integration("stock counts", { timeout: 300_000 }, () => {
  it("freezes the books' figures, takes counts, and shows the variance before anything changes", async () => {
    const context = await setup();
    const started = await start(context);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({ status: "counting", scope: "full", locationName: "Main Store" });
    expect(started.body.number).toMatch(/^SC-KHI-\d{6}$/);
    expect(started.body.summary).toMatchObject({ items: 3, counted: 0, uncounted: 3, differences: 0 });
    expect(line(started.body, "A")).toMatchObject({ expectedBase: "100", countedBase: null });
    const id = started.body.id as string;

    // 98 of A (2 short), 55 of B (5 over), C not counted.
    const counted = await enter(context, id, [
      { variantId: context.a.variantId, unitId: context.a.pieceId, quantity: "98" },
      { variantId: context.b.variantId, unitId: context.b.pieceId, quantity: "55" },
    ]);
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    expect(counted.body.summary).toMatchObject({ counted: 2, uncounted: 1, differences: 2, overUnits: "5", shortUnits: "2", netValuePaisa: 800, overValuePaisa: 1000, shortValuePaisa: 200 });
    expect(line(counted.body, "A")).toMatchObject({ countedBase: "98", varianceBase: "-2", varianceValuePaisa: -200 });
    expect(line(counted.body, "B")).toMatchObject({ countedBase: "55", varianceBase: "5", varianceValuePaisa: 1000 });
    expect(line(counted.body, "C")).toMatchObject({ countedBase: null, varianceBase: null });

    // Counting changed no stock.
    expect(await onHand(context, "A")).toBe("100");
  });

  it("approval posts one adjustment for the differences only; uncounted items are left alone", async () => {
    const context = await setup();
    const id = (await start(context)).body.id as string;
    await enter(context, id, [
      { variantId: context.a.variantId, unitId: context.a.pieceId, quantity: "98" },
      { variantId: context.b.variantId, unitId: context.b.pieceId, quantity: "55" },
    ]);
    expect((await act(context, id, "approve")).status).toBe(409); // not submitted yet
    const submitted = await act(context, id, "submit");
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.status).toBe("submitted");
    // A submitted count is read-only.
    expect((await enter(context, id, [{ variantId: context.a.variantId, unitId: context.a.pieceId, quantity: "1" }])).status).toBe(409);

    const approved = await act(context, id, "approve", { note: "Checked the shelf again" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: "approved", reviewNote: "Checked the shelf again" });
    expect(approved.body.adjustmentId).toBeTruthy();
    expect(await onHand(context, "A")).toBe("98");
    expect(await onHand(context, "B")).toBe("55");
    expect(await onHand(context, "C")).toBe("10");

    const adjustment = await callApi(context.business.ownerToken, "GET", `/stock-adjustments/${approved.body.adjustmentId}`);
    expect(adjustment.body).toMatchObject({ status: "approved", reason: "correction", note: `Stock count ${approved.body.number}` });
    expect(adjustment.body.lines).toHaveLength(2);
    expect((await act(context, id, "approve")).status).toBe(409);
    // The location is free for another count.
    expect((await start(context)).status).toBe(201);
  });

  it("measures against the frozen figure, so a sale made while counting is not taken out twice", async () => {
    const context = await setup();
    const id = (await start(context, { scope: "partial", variantIds: [context.a.variantId] })).body.id as string;
    // 10 pieces leave while the shelf is being counted (a stock adjustment stands in for a sale).
    const out = await callApi(context.business.ownerToken, "POST", "/stock-adjustments", {
      idempotencyKey: key(), body: { locationId: context.main, reason: "damage", lines: [{ variantId: context.a.variantId, unitId: context.a.pieceId, quantity: "-10" }] },
    });
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    // The counter finished the shelf before that happened: 100.
    const counted = await enter(context, id, [{ variantId: context.a.variantId, unitId: context.a.pieceId, quantity: "100" }]);
    expect(line(counted.body, "A")).toMatchObject({ expectedBase: "100", countedBase: "100", varianceBase: "0", movedSinceBase: "-10" });
    await act(context, id, "submit");
    const approved = await act(context, id, "approve");
    expect(approved.body.adjustmentId).toBeNull(); // no difference, nothing to post
    expect(await onHand(context, "A")).toBe("90");
  });

  it("refuses an approval that would take stock below zero, and lets the count go back for a recount", async () => {
    const context = await setup();
    const id = (await start(context, { scope: "partial", variantIds: [context.c.variantId] })).body.id as string;
    await enter(context, id, [{ variantId: context.c.variantId, unitId: context.c.pieceId, quantity: "0" }]); // C: counted none, expected 10
    await callApi(context.business.ownerToken, "POST", "/stock-adjustments", {
      idempotencyKey: key(), body: { locationId: context.main, reason: "damage", lines: [{ variantId: context.c.variantId, unitId: context.c.pieceId, quantity: "-8" }] },
    });
    await act(context, id, "submit");
    const refused = await act(context, id, "approve");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("STOCK_INSUFFICIENT");
    expect(await onHand(context, "C")).toBe("2");
    // Sent back, recounted, approved.
    const back = await act(context, id, "reopen", { note: "Count C again" });
    expect(back.body).toMatchObject({ status: "counting", reviewNote: "Count C again" });
    // What differed is counted afresh against the shelf as it is now: 2 expected, not counted yet.
    expect(line(back.body, "C")).toMatchObject({ expectedBase: "2", countedBase: null });
    await enter(context, id, [{ variantId: context.c.variantId, unitId: context.c.pieceId, quantity: "2" }]);
    await act(context, id, "submit");
    expect((await act(context, id, "approve")).body.status).toBe("approved");
  });

  it("scans barcodes: each scan adds one of that barcode's unit, and an unexpected item joins the count", async () => {
    const context = await setup();
    const id = (await start(context, { scope: "partial", variantIds: [context.a.variantId] })).body.id as string;
    const scan = (code: string, quantity?: string) => callApi(context.business.ownerToken, "POST", `/stock-counts/${id}/scan`, { body: { code, ...(quantity ? { quantity } : {}) } });
    expect((await scan("A-PC")).body).toMatchObject({ sku: "A", countedBase: "1", expectedBase: "100" });
    expect((await scan("A-PC")).body.countedBase).toBe("2");
    expect((await scan("A-PK")).body.countedBase).toBe("12"); // a pack is 10 pieces
    expect((await scan("A-PC", "3")).body.countedBase).toBe("15");
    // B was not in the partial count; scanning it adds it with the books' figure frozen now.
    expect((await scan("B-PC")).body).toMatchObject({ sku: "B", countedBase: "1", expectedBase: "50" });
    expect((await scan("NO-SUCH-CODE")).status).toBe(404);
    expect((await callApi(context.business.ownerToken, "GET", `/stock-counts/${id}`)).body.summary.items).toBe(2);
  });

  it("adds to a count with 'add' mode, filters and searches the lines, and pages them", async () => {
    const context = await setup();
    const id = (await start(context)).body.id as string;
    await enter(context, id, [{ variantId: context.a.variantId, unitId: context.a.pieceId, quantity: "40" }]);
    const more = await enter(context, id, [{ variantId: context.a.variantId, unitId: context.a.pieceId, quantity: "58" }], "add");
    expect(line(more.body, "A").countedBase).toBe("98");
    const uncounted = await callApi(context.business.ownerToken, "GET", `/stock-counts/${id}?filter=uncounted`);
    expect(uncounted.body.lines.data.map((row: { sku: string }) => row.sku).sort()).toEqual(["B", "C"]);
    expect((await callApi(context.business.ownerToken, "GET", `/stock-counts/${id}?filter=differences`)).body.lines.data.map((row: { sku: string }) => row.sku)).toEqual(["A"]);
    expect((await callApi(context.business.ownerToken, "GET", `/stock-counts/${id}?q=B`)).body.lines.data.map((row: { sku: string }) => row.sku)).toEqual(["B"]);
    const paged = await callApi(context.business.ownerToken, "GET", `/stock-counts/${id}?pageSize=2&page=2`);
    expect(paged.body.lines).toMatchObject({ total: 3, page: 2 });
    expect(paged.body.lines.data).toHaveLength(1);
  });

  it("allows one open count per location, nothing counted cannot be submitted, and a cancelled count changes nothing", async () => {
    const context = await setup();
    const id = (await start(context)).body.id as string;
    const second = await start(context);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("COUNT_ALREADY_OPEN");
    const empty = await act(context, id, "submit");
    expect(empty.status).toBe(409);
    expect(empty.body.error.code).toBe("NOTHING_COUNTED");
    await enter(context, id, [{ variantId: context.a.variantId, unitId: context.a.pieceId, quantity: "1" }]);
    expect((await act(context, id, "cancel", { note: "Wrong shelf" })).body.status).toBe("cancelled");
    expect(await onHand(context, "A")).toBe("100");
    expect((await act(context, id, "submit")).status).toBe(409);
    expect((await start(context)).status).toBe(201);
  });

  it("validates a count: a real location, items that exist, counts that are numbers, and units the item is sold in", async () => {
    const context = await setup();
    expect((await start(context, { locationId: crypto.randomUUID() })).status).toBe(404);
    expect((await start(context, { scope: "partial", variantIds: [] })).status).toBe(400);
    expect((await start(context, { scope: "partial", variantIds: [crypto.randomUUID()] })).status).toBe(422);
    const id = (await start(context)).body.id as string;
    expect((await enter(context, id, [{ variantId: context.a.variantId, unitId: context.a.pieceId, quantity: "-1" }])).status).toBe(400);
    expect((await enter(context, id, [{ variantId: context.a.variantId, unitId: context.a.pieceId, quantity: "abc" }])).status).toBe(400);
    expect((await enter(context, id, [{ variantId: context.a.variantId, unitId: crypto.randomUUID(), quantity: "1" }])).status).toBe(422);
    expect((await callApi(context.business.ownerToken, "GET", "/stock-counts/not-a-uuid")).status).toBe(404);
  });

  it("keeps the record safe: no deletes, no edits behind the API's back, permissions and business boundaries", async () => {
    const context = await setup();
    const id = (await start(context)).body.id as string;
    await enter(context, id, [{ variantId: context.a.variantId, unitId: context.a.pieceId, quantity: "98" }]);
    await act(context, id, "submit");
    const client = sql();
    try {
      await expect(client`DELETE FROM stock_counts WHERE id = ${id}`).rejects.toThrow(/cannot be deleted/);
      await expect(client`UPDATE stock_count_lines SET counted_base = 1 WHERE count_id = ${id}`).rejects.toThrow(/cannot be changed/);
      await expect(client`UPDATE stock_counts SET location_id = ${context.main}, scope = 'partial' WHERE id = ${id}`).rejects.toThrow(/cannot be changed/);
    } finally {
      await client.end();
    }

    const counter = await inviteStaffWithPermissions(context.business, "Counter", ["inventory.view", "inventory.count"]);
    expect((await callApi(counter.token, "GET", `/stock-counts/${id}`)).status).toBe(200);
    expect((await callApi(counter.token, "POST", `/stock-counts/${id}/approve`, { body: {}, idempotencyKey: key() })).status).toBe(403);
    expect((await callApi(counter.token, "POST", `/stock-counts/${id}/reopen`, { body: {}, idempotencyKey: key() })).status).toBe(403);
    const viewer = await inviteStaffWithPermissions(context.business, "Viewer", ["inventory.view"]);
    expect((await callApi(viewer.token, "POST", "/stock-counts", { body: { locationId: context.main, scope: "full" }, idempotencyKey: key() })).status).toBe(403);
    // The counter sees quantities but no costs.
    const seen = await callApi(counter.token, "GET", `/stock-counts/${id}`);
    expect(seen.body.summary).not.toHaveProperty("netValuePaisa");
    expect(seen.body.lines.data[0]).not.toHaveProperty("costPaisa");

    const other = await createTestBusiness();
    expect((await callApi(other.ownerToken, "GET", `/stock-counts/${id}`)).status).toBe(404);
    expect((await callApi(other.ownerToken, "POST", `/stock-counts/${id}/approve`, { body: {}, idempotencyKey: key() })).status).toBe(404);
  });
});
