// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

// v0.8 slice 1 against the real API and database: the FBR settings, the encrypted token, test connection, reference data and the mappings.
// FBR itself is the built-in mock: the token chooses how it behaves (mock-ok, mock-down, mock-auth, mock-reject).

const seller = { sellerName: "Example Traders (Pvt) Ltd", sellerNtn: "1234567-8", sellerStrn: "17-00-1234-567-89", sellerProvince: "SINDH", sellerAddress: "Shop 4, Saddar, Karachi" };
const config = (extra: Record<string, unknown> = {}) => ({ enabled: false, mode: "di", environment: "sandbox", ...seller, cancelWindowHours: 72, buyerIdThresholdPaisa: 5_000_000, confirmUntested: false, ...extra });
const setToken = (business: { ownerToken: string }, token: string) => callApi(business.ownerToken, "PUT", "/fbr/token", { body: { token } });

integration("FBR settings", { timeout: 300_000 }, () => {
  it("starts switched off with no token, on the mock, and with nine sandbox scenarios to pass", async () => {
    const business = await createTestBusiness();
    const result = await callApi(business.ownerToken, "GET", "/fbr/config");
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ enabled: false, mode: "di", environment: "sandbox", token: { set: false, hint: null }, adapter: "mock", allScenariosPassed: false, cancelWindowHours: 72, buyerIdThresholdPaisa: 5_000_000, lastTest: null });
    expect(result.body.scenarios).toHaveLength(9);
    expect(result.body.scenarios.every((scenario: { passed: boolean | null }) => scenario.passed === null)).toBe(true);
    expect(result.body.suggestedSeller).toMatchObject({ name: "Example Traders (Pvt) Ltd" });
  });

  it("only the owner changes anything; a manager looks, a cashier sees nothing", async () => {
    const business = await createTestBusiness();
    const manager = await inviteTestStaff(business, "Manager");
    const cashier = await inviteTestStaff(business, "Cashier");
    expect((await callApi(manager.token, "GET", "/fbr/config")).status).toBe(200);
    expect((await callApi(manager.token, "GET", "/fbr/readiness")).status).toBe(200);
    for (const [method, path, body] of [["PUT", "/fbr/config", config()], ["PUT", "/fbr/token", { token: "mock-ok" }], ["DELETE", "/fbr/token", undefined], ["POST", "/fbr/test", {}], ["POST", "/fbr/sync-reference", {}]] as const) {
      expect((await callApi(manager.token, method, path, { body })).status, `manager ${method} ${path}`).toBe(403);
    }
    for (const path of ["/fbr/config", "/fbr/readiness", "/fbr/reference?kind=uom", "/fbr/terminals"]) expect((await callApi(cashier.token, "GET", path)).status, path).toBe(403);
  });

  it("keeps the token encrypted and never sends it back, in answers, in the database or in the audit trail", async () => {
    const business = await createTestBusiness();
    const secret = "mock-ok-SECRET-1234567890abcdef";
    const stored = await setToken(business, secret);
    expect(stored.status, JSON.stringify(stored.body)).toBe(200);
    expect(stored.body.token).toMatchObject({ set: true, hint: "••••cdef" });
    expect(JSON.stringify(stored.body)).not.toContain(secret);
    expect(JSON.stringify((await callApi(business.ownerToken, "GET", "/fbr/config")).body)).not.toContain("SECRET");

    const client = sql();
    const [row] = await client<{ token_encrypted: string; token_hint: string }[]>`SELECT token_encrypted, token_hint FROM fbr_config WHERE business_id = ${business.businessId}`;
    expect(row.token_encrypted).toMatch(/^v1\./);
    expect(row.token_encrypted).not.toContain("SECRET");
    expect(row.token_hint).toBe("••••cdef");
    const audits = await client<{ action: string; after: unknown }[]>`SELECT action, after FROM audit_log WHERE business_id = ${business.businessId} AND entity = 'fbr_config'`;
    await client.end();
    expect(audits.map((entry) => entry.action)).toContain("token_set");
    expect(JSON.stringify(audits)).not.toContain("SECRET");
    expect((await setToken(business, "short")).status).toBe(400);

    const removed = await callApi(business.ownerToken, "DELETE", "/fbr/token");
    expect(removed.body.token).toMatchObject({ set: false, hint: null });
  });

  it("will not switch on until there is a token and the seller's details", async () => {
    const business = await createTestBusiness();
    const noToken = await callApi(business.ownerToken, "PUT", "/fbr/config", { body: config({ enabled: true }) });
    expect(noToken.status).toBe(422);
    expect(noToken.body.error.code).toBe("FBR_NOT_READY");
    expect(noToken.body.error.message).toContain("Enter the FBR security token first");
    await setToken(business, "mock-ok-token");
    const noSeller = await callApi(business.ownerToken, "PUT", "/fbr/config", { body: config({ enabled: true, sellerNtn: "", sellerAddress: "", sellerProvince: "" }) });
    expect(noSeller.status).toBe(422);
    expect(noSeller.body.error.message).toMatch(/NTN.*province.*address/);
    const on = await callApi(business.ownerToken, "PUT", "/fbr/config", { body: config({ enabled: true, mode: "both" }) });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, mode: "both", environment: "sandbox", seller: { ntn: "1234567-8", province: "SINDH" } });
    expect((await callApi(business.ownerToken, "PUT", "/fbr/config", { body: { enabled: true, mode: "xyz", environment: "sandbox" } })).status).toBe(400);
  });

  it("tests the connection and remembers the answer; a wrong token or FBR being down says so", async () => {
    const business = await createTestBusiness();
    expect((await callApi(business.ownerToken, "POST", "/fbr/test")).status).toBe(409);
    await setToken(business, "mock-ok-token");
    const ok = await callApi(business.ownerToken, "POST", "/fbr/test");
    expect(ok.body).toMatchObject({ ok: true, environment: "sandbox", adapter: "mock" });
    expect((await callApi(business.ownerToken, "GET", "/fbr/config")).body.lastTest).toMatchObject({ ok: true });
    await setToken(business, "mock-auth");
    expect((await callApi(business.ownerToken, "GET", "/fbr/config")).body.lastTest).toBeNull(); // a new token has not been tested
    expect((await callApi(business.ownerToken, "POST", "/fbr/test")).body).toMatchObject({ ok: false, message: expect.stringContaining("refused the security token") });
    await setToken(business, "mock-down");
    expect((await callApi(business.ownerToken, "POST", "/fbr/test")).body).toMatchObject({ ok: false, message: expect.stringContaining("could not be reached") });
    expect((await callApi(business.ownerToken, "GET", "/fbr/config")).body.lastTest).toMatchObject({ ok: false });
  });

  it("keeps production behind the sandbox scenarios unless the owner says to go live without them", async () => {
    const business = await createTestBusiness();
    await setToken(business, "mock-ok-token");
    await callApi(business.ownerToken, "PUT", "/fbr/config", { body: config() });
    await callApi(business.ownerToken, "POST", "/fbr/test");
    const refused = await callApi(business.ownerToken, "PUT", "/fbr/config", { body: config({ environment: "production" }) });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("SCENARIOS_NOT_PASSED");
    const live = await callApi(business.ownerToken, "PUT", "/fbr/config", { body: config({ environment: "production", confirmUntested: true }) });
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(live.body.environment).toBe("production");
    // A different environment is a different FBR, so the sandbox test no longer counts.
    expect(live.body.lastTest).toBeNull();
    // Moving back to the sandbox needs no confirmation.
    expect((await callApi(business.ownerToken, "PUT", "/fbr/config", { body: config() })).status).toBe(200);
  });

  it("syncs FBR's lists, searches them, and says which list could not be read", async () => {
    const business = await createTestBusiness();
    await setToken(business, "mock-ok-token");
    const synced = await callApi(business.ownerToken, "POST", "/fbr/sync-reference");
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body.results.map((result: { kind: string; ok: boolean }) => [result.kind, result.ok])).toEqual([["province", true], ["hs_code", true], ["uom", true], ["sale_type", true]]);
    const config1 = (await callApi(business.ownerToken, "GET", "/fbr/config")).body;
    expect(config1.referenceCounts).toEqual({ province: 4, hs_code: 3, uom: 4, sale_type: 5 });
    expect(config1.lastSyncAt).not.toBeNull();
    const found = await callApi(business.ownerToken, "GET", "/fbr/reference?kind=hs_code&q=toys");
    expect(found.body.data).toEqual([{ code: "9503.0090", description: "Toys, other" }]);
    expect((await callApi(business.ownerToken, "GET", "/fbr/reference?kind=province&pageSize=2&page=2")).body).toMatchObject({ total: 4, data: [{ code: "PUNJAB" }, { code: "SINDH" }] });
    expect((await callApi(business.ownerToken, "GET", "/fbr/reference?kind=nonsense")).status).toBe(400);
    // Syncing again replaces the lists rather than doubling them.
    await callApi(business.ownerToken, "POST", "/fbr/sync-reference");
    expect((await callApi(business.ownerToken, "GET", "/fbr/config")).body.referenceCounts.hs_code).toBe(3);
    await setToken(business, "mock-down");
    const down = await callApi(business.ownerToken, "POST", "/fbr/sync-reference");
    expect(down.body.results.every((result: { ok: boolean }) => !result.ok)).toBe(true);
    expect((await callApi(business.ownerToken, "GET", "/fbr/config")).body.referenceCounts.hs_code).toBe(3); // the old lists are kept
  });

  it("maps terminals, payment methods and tax categories, and lists what is still missing before switching on", async () => {
    const business = await createTestBusiness();
    const tax = (await callApi(business.ownerToken, "POST", "/tax-categories", { body: { name: "GST 18%", kind: "standard", rateBps: 1800 } })).body;
    await createSimpleProduct(business, "A", 100, { taxCategoryId: tax.id });
    const before = (await callApi(business.ownerToken, "GET", "/fbr/readiness")).body;
    expect(before.ready).toBe(false);
    const gap = (key: string) => before.gaps.find((entry: { key: string }) => entry.key === key);
    expect(gap("hs_code")).toMatchObject({ total: 1, examples: ["Product A"], blocksSales: true });
    expect(gap("uom").total).toBe(3); // piece, pack and carton
    expect(gap("sale_type")).toMatchObject({ total: 1, examples: ["GST 18%"] });
    expect(gap("payment_code")).toMatchObject({ total: 5, blocksSales: false });
    expect(before.sellerProblems).toContain("Enter the seller's NTN in the FBR settings");

    const terminals = (await callApi(business.ownerToken, "GET", "/fbr/terminals")).body.data;
    expect(terminals).toMatchObject([{ name: "Register 1", fbrPosId: "", fbrEnabled: true }]);
    expect((await callApi(business.ownerToken, "PUT", `/fbr/terminals/${terminals[0].id}`, { body: { fbrPosId: "POS-123456", fbrEnabled: false } })).status).toBe(200);
    expect((await callApi(business.ownerToken, "GET", "/fbr/terminals")).body.data[0]).toMatchObject({ fbrPosId: "POS-123456", fbrEnabled: false });
    const methods = (await callApi(business.ownerToken, "GET", "/fbr/payment-methods")).body.data;
    expect((await callApi(business.ownerToken, "PUT", `/fbr/payment-methods/${methods[0].id}`, { body: { fbrPaymentCode: "1" } })).status).toBe(200);
    expect((await callApi(business.ownerToken, "PUT", `/fbr/tax-categories/${tax.id}`, { body: { fbrSaleType: "Goods at standard rate (default)" } })).status).toBe(200);
    expect((await callApi(business.ownerToken, "GET", "/fbr/tax-categories")).body.data.find((row: { id: string }) => row.id === tax.id)).toMatchObject({ fbrSaleType: "Goods at standard rate (default)", rateBps: 1800 });
    expect((await callApi(business.ownerToken, "PUT", `/fbr/terminals/${crypto.randomUUID()}`, { body: { fbrPosId: "", fbrEnabled: true } })).status).toBe(404);

    const after = (await callApi(business.ownerToken, "GET", "/fbr/readiness")).body;
    expect(after.gaps.find((entry: { key: string }) => entry.key === "sale_type").total).toBe(0);
    expect(after.gaps.find((entry: { key: string }) => entry.key === "payment_code").total).toBe(4);
    // Another business sees none of this.
    const other = await createTestBusiness();
    expect((await callApi(other.ownerToken, "PUT", `/fbr/tax-categories/${tax.id}`, { body: { fbrSaleType: "x" } })).status).toBe(404);
  });

  it("checks whether a buyer is registered with FBR", async () => {
    const business = await createTestBusiness();
    const viewer = await inviteStaffWithPermissions(business, "FBR viewer", ["fbr.view"]);
    expect((await callApi(viewer.token, "POST", "/fbr/verify-buyer", { body: { registrationNo: "7654321-1" } })).status).toBe(409); // no token yet
    await setToken(business, "mock-ok-token");
    expect((await callApi(viewer.token, "POST", "/fbr/verify-buyer", { body: { registrationNo: "7654321-1" } })).body).toMatchObject({ ok: true, registered: true });
    expect((await callApi(viewer.token, "POST", "/fbr/verify-buyer", { body: { registrationNo: "7654320-0" } })).body).toMatchObject({ ok: true, registered: false });
    expect((await callApi(viewer.token, "POST", "/fbr/verify-buyer", { body: { registrationNo: "12" } })).status).toBe(400);
  });
});
