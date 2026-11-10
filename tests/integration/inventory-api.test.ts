// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  callApi, createSimpleProduct, createTestBusiness, firstLocationId, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff,
  setAdjustmentThreshold, sql, type TestBusiness,
} from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

const key = () => `key-${crypto.randomUUID()}`;
const adjust = (token: string, body: unknown, idempotencyKey = key()) => callApi(token, "POST", "/stock-adjustments", { body, idempotencyKey });
const line = (product: { variantId: string; pieceId: string }, quantity: string, extra: Record<string, unknown> = {}) =>
  ({ variantId: product.variantId, unitId: product.pieceId, quantity, ...extra });
const stockOf = async (business: TestBusiness, variantId: string) =>
  (await callApi(business.ownerToken, "POST", "/stock/levels", { body: { variantIds: [variantId] } })).body[0];

/** Puts stock on a SKU the supported way: an approved opening-stock import. */
async function openStock(business: TestBusiness, sku: string, quantity: string, unit = "Piece", cost = "") {
  const csv = ["sku,quantity,unit,cost", `${sku},${quantity},${unit},${cost}`].join("\n");
  const response = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv }, idempotencyKey: key() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

integration("inventory API", { timeout: 120_000 }, () => {
  it("separates who can look, who can request and who can approve", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "PERM-1");
    const cashier = await inviteTestStaff(business, "Cashier");
    const requester = await inviteStaffWithPermissions(business, "Stock clerk", ["catalog.view", "inventory.view", "inventory.adjust"]);

    for (const path of ["/stock", `/stock/ledger?variantId=${product.variantId}`, "/stock-adjustments"]) {
      expect((await callApi(cashier.token, "GET", path)).status, path).toBe(200);
    }
    expect((await callApi(cashier.token, "POST", "/stock/levels", { body: { variantIds: [product.variantId] } })).status).toBe(200);
    const body = { locationId: await firstLocationId(business), reason: "found", lines: [line(product, "1")] };
    for (const [method, path, payload] of [
      ["POST", "/stock-adjustments", body], ["POST", `/stock-adjustments/${crypto.randomUUID()}/approve`, undefined],
      ["POST", `/stock-adjustments/${crypto.randomUUID()}/reject`, { reason: "no" }], ["POST", "/stock/opening", { csv: "sku,quantity\nA,1" }],
      ["POST", "/stock/opening/preview", { csv: "sku,quantity\nA,1" }], ["GET", "/stock/valuation", undefined],
    ] as const) {
      const response = await callApi(cashier.token, method, path, { body: payload, idempotencyKey: key() });
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    expect((await adjust(requester.token, body)).status).toBe(201);
    expect((await callApi(requester.token, "POST", `/stock-adjustments/${crypto.randomUUID()}/approve`, { idempotencyKey: key() })).status).toBe(403);
    expect((await callApi(requester.token, "GET", "/stock/valuation")).status).toBe(403);
  });

  it("opens stock in cartons and shows it as pieces (acceptance: 10 cartons = 2,000 pieces)", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "OPEN-1", 100);
    const result = await openStock(business, "OPEN-1", "10", "Carton", "3200.00");
    expect(result).toMatchObject({ locations: 1, lines: 1, valuePaisa: 3_200_000 / 2 * 2 });

    expect((await stockOf(business, product.variantId)).onHand).toBe("2000");
    const levels = await callApi(business.ownerToken, "GET", "/stock?q=OPEN-1");
    expect(levels.body.data[0]).toMatchObject({ sku: "OPEN-1", onHand: "2000", available: "2000", avgCostPaisa: 1600, valuePaisa: 3_200_000 });
    expect(levels.body.data[0].units.find((unit: { unitId: string }) => unit.unitId === product.cartonId).factorToBase).toBe("200");

    const ledger = await callApi(business.ownerToken, "GET", `/stock/ledger?variantId=${product.variantId}`);
    expect(ledger.body.data).toHaveLength(1);
    expect(ledger.body.data[0]).toMatchObject({ quantity: "2000", balanceAfter: "2000", docType: "stock_adjustment", unitCostPaisa: 1600 });
  });

  it("previews opening stock problems, refuses a second import for the same SKU, and replays a retried commit", async () => {
    const business = await createTestBusiness();
    await createSimpleProduct(business, "OPEN-2");
    const preview = await callApi(business.ownerToken, "POST", "/stock/opening/preview", { body: { csv: "sku,quantity,unit\nOPEN-2,5,Bucket\nMISSING,1," } });
    expect(preview.body.canImport).toBe(false);
    expect(preview.body.issues.map((issue: { row: number; field: string }) => `${issue.row}:${issue.field}`)).toEqual(["2:unit", "3:sku"]);
    const blocked = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit\nOPEN-2,5,Bucket" }, idempotencyKey: key() });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe("IMPORT_HAS_ERRORS");

    const csv = "sku,quantity\nOPEN-2,5";
    const retryKey = key();
    const first = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv }, idempotencyKey: retryKey });
    const retry = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv }, idempotencyKey: retryKey });
    expect([first.status, retry.status]).toEqual([201, 201]);
    expect(retry.headers.get("Idempotent-Replay")).toBe("true");
    expect(retry.body).toEqual(first.body);

    const again = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv }, idempotencyKey: key() });
    expect(again.status).toBe(422);
    expect(again.body.error.details[0].message).toContain("already has stock movements");
    const adjustments = await callApi(business.ownerToken, "GET", "/stock-adjustments");
    expect(adjustments.body.total).toBe(1);
  });

  it("posts a small adjustment straight away", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "ADJ-1", 100);
    const clerk = await inviteStaffWithPermissions(business, "Stock clerk", ["catalog.view", "inventory.view", "inventory.adjust"]);
    const response = await adjust(clerk.token, { locationId: await firstLocationId(business), reason: "found", note: "Behind the shelf", lines: [line(product, "5")] });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ status: "approved", reason: "found", note: "Behind the shelf", createdByName: "Stock clerk" });
    expect(response.body).not.toHaveProperty("totalValuePaisa");
    expect(response.body.lines[0]).toMatchObject({ sku: "ADJ-1", qtyEntered: "5", qtyBaseDelta: "5" });
    expect(response.body.lines[0]).not.toHaveProperty("unitCostPaisa");
    expect((await stockOf(business, product.variantId)).onHand).toBe("5");
  });

  it("holds an adjustment above the threshold until a manager approves it (acceptance)", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "ADJ-2", 1000);
    await openStock(business, "ADJ-2", "100");
    await setAdjustmentThreshold(business, 50_000); // PKR 500
    const clerk = await inviteStaffWithPermissions(business, "Stock clerk", ["catalog.view", "inventory.view", "inventory.adjust"]);
    const locationId = await firstLocationId(business);

    // 60 pieces lost at Rs 10 = Rs 600, over the threshold.
    const pending = await adjust(clerk.token, { locationId, reason: "damage", lines: [line(product, "-60")] });
    expect(pending.status).toBe(201);
    expect(pending.body.status).toBe("pending");
    expect((await stockOf(business, product.variantId)).onHand).toBe("100");
    expect((await callApi(business.ownerToken, "GET", `/stock/ledger?variantId=${product.variantId}`)).body.total).toBe(1);

    const queue = await callApi(business.ownerToken, "GET", "/stock-adjustments?status=pending");
    expect(queue.body.data.map((row: { id: string }) => row.id)).toEqual([pending.body.id]);
    expect(queue.body.data[0]).toMatchObject({ lineCount: 1, createdByName: "Stock clerk", totalValuePaisa: 60_000 });

    const approved = await callApi(business.ownerToken, "POST", `/stock-adjustments/${pending.body.id}/approve`, { idempotencyKey: key() });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: "approved", approvedByName: business.ownerEmail.split("@")[0] });
    expect((await stockOf(business, product.variantId)).onHand).toBe("40");

    const ledger = await callApi(business.ownerToken, "GET", `/stock/ledger?variantId=${product.variantId}`);
    expect(ledger.body.data.map((row: { quantity: string; balanceAfter: string }) => [row.quantity, row.balanceAfter])).toEqual([["-60", "40"], ["100", "100"]]);

    expect((await callApi(business.ownerToken, "POST", `/stock-adjustments/${pending.body.id}/approve`, { idempotencyKey: key() })).body.error.code).toBe("ADJUSTMENT_NOT_PENDING");
    const audit = await callApi(business.ownerToken, "GET", "/audit-log?pageSize=100");
    expect(audit.body.data.map((entry: { entity: string; action: string }) => `${entry.entity}:${entry.action}`)).toEqual(expect.arrayContaining(["stock_adjustment:create", "stock_adjustment:approve"]));
  });

  it("lets an approver post a large adjustment immediately, and rejects with a reason", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "ADJ-3", 1000);
    await setAdjustmentThreshold(business, 50_000);
    const locationId = await firstLocationId(business);
    const manager = await inviteTestStaff(business, "Manager");
    const clerk = await inviteStaffWithPermissions(business, "Stock clerk", ["catalog.view", "inventory.view", "inventory.adjust"]);

    const large = await adjust(manager.token, { locationId, reason: "found", lines: [line(product, "100", { unitCostPaisa: 1000 })] });
    expect(large.body.status).toBe("approved");
    expect(large.body.totalValuePaisa).toBe(100_000);
    expect((await stockOf(business, product.variantId)).onHand).toBe("100");

    const pending = await adjust(clerk.token, { locationId, reason: "theft", lines: [line(product, "-80")] });
    expect(pending.body.status).toBe("pending");
    expect((await callApi(clerk.token, "POST", `/stock-adjustments/${pending.body.id}/reject`, { body: { reason: "x" } })).status).toBe(403);
    expect((await callApi(manager.token, "POST", `/stock-adjustments/${pending.body.id}/reject`, { body: {} })).status).toBe(400);
    const rejected = await callApi(manager.token, "POST", `/stock-adjustments/${pending.body.id}/reject`, { body: { reason: "Recount first" } });
    expect(rejected.body).toMatchObject({ status: "rejected" });
    expect(rejected.body.note).toContain("Rejected: Recount first");
    expect((await stockOf(business, product.variantId)).onHand).toBe("100");
    expect((await callApi(manager.token, "POST", `/stock-adjustments/${pending.body.id}/approve`, { idempotencyKey: key() })).status).toBe(409);
    expect((await callApi(manager.token, "POST", `/stock-adjustments/${pending.body.id}/reject`, { body: { reason: "again" } })).status).toBe(409);
  });

  it("never takes stock below zero, at request time or at approval time", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "NEG-1", 100);
    await openStock(business, "NEG-1", "10");
    const locationId = await firstLocationId(business);
    const tooMuch = await adjust(business.ownerToken, { locationId, reason: "damage", lines: [line(product, "-11")] });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatchObject({ code: "STOCK_INSUFFICIENT", message: "Not enough stock of NEG-1: 10 on hand" });
    expect((await callApi(business.ownerToken, "GET", "/stock-adjustments")).body.total).toBe(1);

    await setAdjustmentThreshold(business, 0);
    const clerk = await inviteStaffWithPermissions(business, "Stock clerk", ["catalog.view", "inventory.view", "inventory.adjust"]);
    const first = await adjust(clerk.token, { locationId, reason: "damage", lines: [line(product, "-8")] });
    const second = await adjust(clerk.token, { locationId, reason: "theft", lines: [line(product, "-8")] });
    expect([first.body.status, second.body.status]).toEqual(["pending", "pending"]);
    expect((await callApi(business.ownerToken, "POST", `/stock-adjustments/${first.body.id}/approve`, { idempotencyKey: key() })).status).toBe(200);
    const second_ = await callApi(business.ownerToken, "POST", `/stock-adjustments/${second.body.id}/approve`, { idempotencyKey: key() });
    expect(second_.status).toBe(409);
    expect(second_.body.error.code).toBe("STOCK_INSUFFICIENT");
    expect((await callApi(business.ownerToken, "GET", `/stock-adjustments/${second.body.id}`)).body.status).toBe("pending");
    expect((await stockOf(business, product.variantId)).onHand).toBe("2");
  });

  it("converts the entered unit to base units and costs it correctly", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "UNIT-1", 100);
    const locationId = await firstLocationId(business);
    const received = await adjust(business.ownerToken, {
      locationId, reason: "found",
      lines: [{ variantId: product.variantId, unitId: product.cartonId, quantity: "2.5", unitCostPaisa: 30_000 }],
    });
    expect(received.body.lines[0]).toMatchObject({ qtyEntered: "2.5", qtyBaseDelta: "500", unitCostPaisa: 150 });
    expect(received.body.totalValuePaisa).toBe(75_000);
    expect((await stockOf(business, product.variantId)).onHand).toBe("500");

    const packs = await adjust(business.ownerToken, { locationId, reason: "damage", lines: [{ variantId: product.variantId, unitId: product.packId, quantity: "-3" }] });
    expect(packs.body.lines[0]).toMatchObject({ qtyEntered: "-3", qtyBaseDelta: "-30", unitCostPaisa: 150 });
    expect((await stockOf(business, product.variantId)).onHand).toBe("470");
  });

  it("rejects malformed, foreign and impossible adjustments", async () => {
    const shopA = await createTestBusiness();
    const shopB = await createTestBusiness();
    const product = await createSimpleProduct(shopA, "BAD-1");
    const service = await createSimpleProduct(shopA, "BAD-SVC", 0, { productType: "service" });
    const locationId = await firstLocationId(shopA);
    const valid = { locationId, reason: "found", lines: [line(product, "1")] };

    expect((await adjust(shopA.ownerToken, { ...valid, reason: "opening" })).status).toBe(400);
    expect((await adjust(shopA.ownerToken, { ...valid, lines: [line(product, "0")] })).status).toBe(400);
    expect((await adjust(shopA.ownerToken, { ...valid, lines: [line(product, "1"), line(product, "2")] })).status).toBe(400);
    expect((await adjust(shopA.ownerToken, { ...valid, lines: [] })).status).toBe(400);
    expect((await adjust(shopA.ownerToken, { ...valid, lines: [line(product, "1.0005")] })).status).toBe(400);

    const wrongUnit = await adjust(shopA.ownerToken, { ...valid, lines: [{ variantId: product.variantId, unitId: crypto.randomUUID(), quantity: "1" }] });
    expect(wrongUnit.body.error).toMatchObject({ code: "INVALID_LINE" });
    const fraction = await adjust(shopA.ownerToken, { ...valid, lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity: "0.0001" }] });
    expect(fraction.status).toBe(400);
    const notStocked = await adjust(shopA.ownerToken, { ...valid, lines: [line(service, "1")] });
    expect(notStocked.body.error.message).toContain("not a stocked item");

    expect((await adjust(shopB.ownerToken, valid)).body.error.code).toBe("INVALID_LOCATION");
    expect((await adjust(shopB.ownerToken, { ...valid, locationId: await firstLocationId(shopB) })).body.error.code).toBe("INVALID_LINE");
    expect((await callApi(shopB.ownerToken, "GET", "/stock-adjustments")).body.total).toBe(0);
    expect((await callApi(shopA.ownerToken, "GET", "/stock-adjustments")).body.total).toBe(0);

    const archived = await createSimpleProduct(shopA, "BAD-ARC");
    await callApi(shopA.ownerToken, "DELETE", `/products/${archived.productId}`);
    expect((await adjust(shopA.ownerToken, { ...valid, lines: [line(archived, "1")] })).body.error.message).toContain("archived");
  });

  it("applies an adjustment once however many times the request is sent", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "IDEM-1");
    const body = { locationId: await firstLocationId(business), reason: "found", lines: [line(product, "7")] };
    const sharedKey = key();
    // Two identical requests at once: exactly one runs; the other is told it is already in progress (or replays the result).
    const racing = await Promise.all([adjust(business.ownerToken, body, sharedKey), adjust(business.ownerToken, body, sharedKey)]);
    const winner = racing.find((response) => response.status === 201 && response.headers.get("Idempotent-Replay") !== "true")!;
    expect(winner).toBeDefined();
    for (const response of racing) expect([201, 409]).toContain(response.status);
    const third = await adjust(business.ownerToken, body, sharedKey);
    expect(third.status).toBe(201);
    expect(third.headers.get("Idempotent-Replay")).toBe("true");
    expect(third.body.id).toBe(winner.body.id);
    expect((await stockOf(business, product.variantId)).onHand).toBe("7");
    expect((await adjust(business.ownerToken, { ...body, note: "different" }, sharedKey)).body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await callApi(business.ownerToken, "POST", "/stock-adjustments", { body })).body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("filters the ledger and keeps the running balance correct, within one business", async () => {
    const shopA = await createTestBusiness();
    const shopB = await createTestBusiness();
    const product = await createSimpleProduct(shopA, "LED-1");
    const locationId = await firstLocationId(shopA);
    await openStock(shopA, "LED-1", "100");
    await adjust(shopA.ownerToken, { locationId, reason: "damage", lines: [line(product, "-10")] });
    await adjust(shopA.ownerToken, { locationId, reason: "found", lines: [line(product, "4")] });

    const all = await callApi(shopA.ownerToken, "GET", `/stock/ledger?variantId=${product.variantId}`);
    expect(all.body.data.map((row: { quantity: string; balanceAfter: string }) => [row.quantity, row.balanceAfter])).toEqual([["4", "94"], ["-10", "90"], ["100", "100"]]);
    expect(all.body.data[0].locationName).toBe("Main Store");
    expect(all.body.variant).toMatchObject({ sku: "LED-1", productName: "Product LED-1", baseUnitId: product.pieceId });

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
    const filtered = await callApi(shopA.ownerToken, "GET", `/stock/ledger?variantId=${product.variantId}&from=${today}&to=${today}&pageSize=2&page=2`);
    expect(filtered.body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(filtered.body.data.map((row: { balanceAfter: string }) => row.balanceAfter)).toEqual(["100"]);
    expect((await callApi(shopA.ownerToken, "GET", `/stock/ledger?variantId=${product.variantId}&to=2000-01-01`)).body.total).toBe(0);
    expect((await callApi(shopA.ownerToken, "GET", `/stock/ledger?variantId=${product.variantId}&docType=nothing`)).body.total).toBe(0);
    expect((await callApi(shopA.ownerToken, "GET", `/stock/ledger?variantId=${product.variantId}&from=yesterday`)).status).toBe(400);
    expect((await callApi(shopA.ownerToken, "GET", "/stock/ledger")).body.error.code).toBe("VARIANT_REQUIRED");
    expect((await callApi(shopB.ownerToken, "GET", `/stock/ledger?variantId=${product.variantId}`)).status).toBe(404);
  });

  it("hides costs from roles without products.cost.view, and flags low stock", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "LOW-1", 100, {});
    await callApi(business.ownerToken, "PUT", `/products/${product.productId}`, {
      body: {
        name: "Product LOW-1", baseUnitId: product.pieceId,
        variants: [{ id: product.variantId, sku: "LOW-1", costPaisa: 100, reorderLevel: "20", units: [{ unitId: product.pieceId, factorToBase: "1", salePricePaisa: 500 }] }],
      },
    });
    await openStock(business, "LOW-1", "15");
    const cashier = await inviteTestStaff(business, "Cashier");

    const seen = await callApi(cashier.token, "GET", "/stock");
    expect(seen.body.data[0]).toMatchObject({ sku: "LOW-1", onHand: "15", low: true, reorderLevel: "20" });
    expect(seen.body.data[0]).not.toHaveProperty("avgCostPaisa");
    expect(seen.body.data[0]).not.toHaveProperty("valuePaisa");
    const ledger = await callApi(cashier.token, "GET", `/stock/ledger?variantId=${product.variantId}`);
    expect(ledger.body.data[0]).not.toHaveProperty("unitCostPaisa");
    expect((await callApi(business.ownerToken, "GET", "/stock")).body.data[0]).toHaveProperty("valuePaisa", 1500);

    expect((await callApi(business.ownerToken, "GET", "/stock?low=true")).body.total).toBe(1);
    await openStock(business, "LOW-1", "0").catch(() => undefined);
    const other = await createSimpleProduct(business, "LOW-2");
    expect((await callApi(business.ownerToken, "GET", "/stock?low=true")).body.data.map((row: { sku: string }) => row.sku)).toEqual(["LOW-1"]);
    expect((await callApi(business.ownerToken, "GET", "/stock")).body.total).toBe(2);
    expect(other.variantId).toBeTruthy();
  });

  it("values stock at cost and sale price as of any date, matching the cached balances", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "VAL-1", 100);
    const locationId = await firstLocationId(business);
    await openStock(business, "VAL-1", "100", "Piece", "10.00");
    await adjust(business.ownerToken, { locationId, reason: "found", lines: [line(product, "50", { unitCostPaisa: 1600 })] });
    await adjust(business.ownerToken, { locationId, reason: "damage", lines: [line(product, "-30")] });

    const current = await callApi(business.ownerToken, "GET", "/stock/valuation");
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    // (100 x 1000 + 50 x 1600) / 150 = 1200 per piece; 120 pieces on hand; sale price Rs 5.00
    expect(current.body.rows[0]).toMatchObject({ sku: "VAL-1", onHand: "120", costValuePaisa: 144_000, salePricePaisa: 500, saleValuePaisa: 60_000 });
    expect(current.body.totals).toEqual({ costValuePaisa: 144_000, saleValuePaisa: 60_000 });
    expect(current.body.salePriceBasis).toBe("current");

    // The replay used for valuation agrees with the balances the database trigger maintains.
    const balances = await callApi(business.ownerToken, "GET", "/stock?q=VAL-1");
    expect(balances.body.data[0]).toMatchObject({ onHand: "120", avgCostPaisa: 1200, valuePaisa: 144_000 });

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
    const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date(Date.now() - 86_400_000));
    expect((await callApi(business.ownerToken, "GET", `/stock/valuation?asOf=${today}`)).body.totals.costValuePaisa).toBe(144_000);
    expect((await callApi(business.ownerToken, "GET", `/stock/valuation?asOf=${yesterday}`)).body.rows).toEqual([]);
    expect((await callApi(business.ownerToken, "GET", "/stock/valuation?asOf=soon")).status).toBe(400);
    expect((await callApi(business.ownerToken, "GET", `/stock/valuation?locationId=${crypto.randomUUID()}`)).body.rows).toEqual([]);
  });

  it("agrees with the database after many movements (replay equals stock_balances)", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "SYNC-1", 100);
    const locationId = await firstLocationId(business);
    for (const [quantity, cost] of [["37", 1234], ["11.5", 999], ["-20", 0], ["8", 1500], ["-5.25", 0]] as const) {
      const response = await adjust(business.ownerToken, { locationId, reason: Number(quantity) > 0 ? "found" : "damage", lines: [line(product, quantity, cost ? { unitCostPaisa: cost } : {})] });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
    const client = sql();
    try {
      const [cached] = await client<{ on_hand: string; avg_cost_paisa: string }[]>`
        SELECT on_hand, avg_cost_paisa FROM stock_balances WHERE variant_id = ${product.variantId}
      `;
      const valuation = await callApi(business.ownerToken, "GET", "/stock/valuation");
      const row = valuation.body.rows[0];
      expect(row.onHand).toBe(String(Number(cached.on_hand)));
      expect(row.costValuePaisa).toBe(Math.round(Number(cached.on_hand) * Number(cached.avg_cost_paisa)));
    } finally {
      await client.end();
    }
  });

  it("keeps businesses apart and answers 404 for unknown adjustments", async () => {
    const shopA = await createTestBusiness();
    const shopB = await createTestBusiness();
    const product = await createSimpleProduct(shopA, "ISO-1");
    await setAdjustmentThreshold(shopA, 0);
    const clerk = await inviteStaffWithPermissions(shopA, "Stock clerk", ["inventory.view", "inventory.adjust"]);
    const pending = await adjust(clerk.token, { locationId: await firstLocationId(shopA), reason: "found", lines: [line(product, "3")] });
    expect(pending.body.status).toBe("pending");

    expect((await callApi(shopB.ownerToken, "GET", `/stock-adjustments/${pending.body.id}`)).status).toBe(404);
    expect((await callApi(shopB.ownerToken, "POST", `/stock-adjustments/${pending.body.id}/approve`, { idempotencyKey: key() })).status).toBe(404);
    expect((await callApi(shopB.ownerToken, "POST", `/stock-adjustments/${pending.body.id}/reject`, { body: { reason: "mine now" } })).status).toBe(404);
    expect((await callApi(shopA.ownerToken, "GET", "/stock-adjustments/not-a-uuid")).status).toBe(404);
    expect((await callApi(shopB.ownerToken, "POST", "/stock/levels", { body: { variantIds: [product.variantId] } })).body).toEqual([]);
    expect((await callApi(shopB.ownerToken, "GET", "/stock")).body.total).toBe(0);
    expect((await callApi(shopA.ownerToken, "GET", `/stock-adjustments/${pending.body.id}`)).body.status).toBe("pending");
  });
});
