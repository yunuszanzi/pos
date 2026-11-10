// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createTestBusiness, hasLocalStack, inviteStaffWithPermissions } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

// v1.0: customers and suppliers loaded by CSV for go-live. Checked row by row, all or nothing, never twice.

const customersCsv = [
  "name,business_name,phone,cnic,credit_limit,terms_days,registered",
  "Bilal Wholesale,Bilal Traders,0301-1111111,42101-1234567-1,50000.00,15,no",
  "Sana Stores,,0302-2222222,,0,0,yes",
].join("\r\n");
const suppliersCsv = ["name,contact_person,phone,ntn,terms_days", "Karachi Balloon Mills,Imran,021-32100000,1234567-8,30", "Lahore Latex,Zubair,042-3500000,,15"].join("\r\n");

integration("importing customers and suppliers", { timeout: 300_000 }, () => {
  it("previews without saving, then imports the customers once and shows them in the list", async () => {
    const business = await createTestBusiness();
    const preview = await callApi(business.ownerToken, "POST", "/customers/import/preview", { body: { csv: customersCsv } });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ canImport: true, issues: [], summary: { rows: 2 } });
    expect((await callApi(business.ownerToken, "GET", "/customers")).body.total).toBe(0);

    const idempotencyKey = key();
    const done = await callApi(business.ownerToken, "POST", "/customers/import", { body: { csv: customersCsv }, idempotencyKey });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toEqual({ imported: 2 });
    // The same request again is answered from the first, not loaded twice.
    const again = await callApi(business.ownerToken, "POST", "/customers/import", { body: { csv: customersCsv }, idempotencyKey });
    expect(again.headers.get("Idempotent-Replay")).toBe("true");
    const list = await callApi(business.ownerToken, "GET", "/customers?pageSize=50");
    expect(list.body.total).toBe(2);
    const bilal = list.body.data.find((row: { name: string }) => row.name === "Bilal Wholesale");
    expect(bilal).toMatchObject({ businessName: "Bilal Traders", creditLimitPaisa: 5_000_000, termsDays: 15, registered: false });
    // A new file with the same people is refused, naming them.
    const repeat = await callApi(business.ownerToken, "POST", "/customers/import", { body: { csv: customersCsv }, idempotencyKey: key() });
    expect(repeat.status).toBe(422);
    expect(repeat.body.error.code).toBe("IMPORT_HAS_ERRORS");
    expect(repeat.body.error.details.map((issue: { row: number; field: string }) => `${issue.row}:${issue.field}`)).toEqual(["2:cnic", "3:name"]);
    expect((await callApi(business.ownerToken, "GET", "/customers")).body.total).toBe(2);
  });

  it("imports nothing when any row is wrong, and says which", async () => {
    const business = await createTestBusiness();
    const csv = "name,phone,credit_limit\nGood One,0300-1234567,100.00\n,0300,abc\nBad Phone,x!,5";
    const preview = await callApi(business.ownerToken, "POST", "/customers/import/preview", { body: { csv } });
    expect(preview.body.canImport).toBe(false);
    expect(preview.body.issues.map((issue: { row: number; field: string }) => `${issue.row}:${issue.field}`).sort()).toEqual(["3:credit_limit", "3:name", "4:phone"]);
    const refused = await callApi(business.ownerToken, "POST", "/customers/import", { body: { csv }, idempotencyKey: key() });
    expect(refused.status).toBe(422);
    expect((await callApi(business.ownerToken, "GET", "/customers")).body.total).toBe(0);
    expect((await callApi(business.ownerToken, "POST", "/customers/import/preview", { body: { csv: "" } })).status).toBe(400);
  });

  it("imports suppliers, and refuses a name already in use", async () => {
    const business = await createTestBusiness();
    const done = await callApi(business.ownerToken, "POST", "/suppliers/import", { body: { csv: suppliersCsv }, idempotencyKey: key() });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toEqual({ imported: 2 });
    const list = await callApi(business.ownerToken, "GET", "/suppliers?pageSize=50");
    expect(list.body.data.map((row: { name: string }) => row.name).sort()).toEqual(["Karachi Balloon Mills", "Lahore Latex"]);
    const clash = await callApi(business.ownerToken, "POST", "/suppliers/import", { body: { csv: "name\nkarachi balloon mills\nNew Supplier" }, idempotencyKey: key() });
    expect(clash.status).toBe(422);
    expect(clash.body.error.details).toEqual([expect.objectContaining({ row: 2, field: "name" })]);
    expect((await callApi(business.ownerToken, "GET", "/suppliers")).body.total).toBe(2);
  });

  it("is for those who manage the parties, and each business keeps its own", async () => {
    const business = await createTestBusiness();
    const viewer = await inviteStaffWithPermissions(business, "Viewer", ["customers.view", "suppliers.view"]);
    for (const path of ["/customers/import", "/suppliers/import", "/customers/import/preview", "/suppliers/import/preview"]) {
      expect((await callApi(viewer.token, "POST", path, { body: { csv: "name\nA" }, idempotencyKey: key() })).status, path).toBe(403);
    }
    await callApi(business.ownerToken, "POST", "/customers/import", { body: { csv: "name,phone\nShared Name,0300-1111111" }, idempotencyKey: key() });
    const other = await createTestBusiness();
    // The same person is a different customer in another shop.
    expect((await callApi(other.ownerToken, "POST", "/customers/import", { body: { csv: "name,phone\nShared Name,0300-1111111" }, idempotencyKey: key() })).status).toBe(201);
    expect((await callApi(other.ownerToken, "GET", "/customers")).body.total).toBe(1);
  });
});
