// @vitest-environment node
import { describe, expect, it } from "vitest";
import { app } from "../../server/app";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteStaffWithPermissions } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

// FR-AUD-03: the owner can take all the business's data away at any time, as one JSON file or as CSV per table. Secrets stay behind.

const download = (token: string, path: string) => app.fetch(new Request(`http://localhost/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } }));

integration("exporting all data", { timeout: 300_000 }, () => {
  it("gives the owner every table of their business as one JSON file, without secrets or anyone else's rows", async () => {
    const business = await createTestBusiness();
    await createSimpleProduct(business, "EXP-A", 100);
    await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Bilal Wholesale", phone: "0301-1111111" } });
    await callApi(business.ownerToken, "PUT", "/fbr/token", { body: { token: "mock-ok-token-secret-value" } });
    const other = await createTestBusiness();
    await callApi(other.ownerToken, "POST", "/customers", { body: { name: "Somebody Else", phone: "0300-0000000" } });

    const response = await download(business.ownerToken, "/export/data");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/attachment; filename="business-data-\d{4}-\d{2}-\d{2}\.json"/);
    const text = await response.text();
    const file = JSON.parse(text);
    expect(file.businessId).toBe(business.businessId);
    expect(file.tables.customers.map((row: { name: string }) => row.name)).toEqual(["Bilal Wholesale"]);
    expect(file.tables.products.map((row: { name: string }) => row.name)).toEqual(["Product EXP-A"]);
    expect(file.tables.businesses).toHaveLength(1);
    expect(file.tables.businesses[0].id).toBe(business.businessId);
    expect(Object.keys(file.tables).length).toBeGreaterThan(30);
    // Nobody else's rows, and none of the secrets.
    expect(text).not.toContain("Somebody Else");
    expect(text).not.toContain("pin_hash");
    expect(text).not.toContain("token_encrypted");
    expect(text).not.toContain("mock-ok-token-secret-value");
    expect(file.tables.fbr_config[0]).not.toHaveProperty("token_encrypted");
    expect(file.tables.users[0]).not.toHaveProperty("pin_hash");
    expect(file.tables).not.toHaveProperty("idempotency_keys");
    expect(file.tables).not.toHaveProperty("document_shares");
    for (const [name, rows] of Object.entries(file.tables) as Array<[string, Array<Record<string, unknown>>]>) {
      for (const row of rows) if ("business_id" in row) expect(row.business_id, name).toBe(business.businessId);
    }
  });

  it("gives any one table as CSV for a spreadsheet, and says which tables there are", async () => {
    const business = await createTestBusiness();
    await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Sana, Stores", phone: "0302-2222222", notes: "=cmd|' /C calc'!A0" } });
    const listed = await callApi(business.ownerToken, "GET", "/export/tables");
    expect(listed.body.data.find((entry: { name: string }) => entry.name === "customers")).toEqual({ name: "customers", rows: 1 });
    expect(listed.body.data.some((entry: { rows: number }) => entry.rows === 0)).toBe(false);

    const response = await download(business.ownerToken, "/export/data?format=csv&table=customers");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const [header, row] = text.slice(1).split(/\r?\n/);
    expect(header.split(",")).toEqual(expect.arrayContaining(["id", "name", "phone", "business_id"]));
    expect(row).toContain('"Sana, Stores"');
    // A cell that looks like a formula is made harmless, as in every other export.
    expect(row).toContain("'=cmd");
    expect((await download(business.ownerToken, "/export/data?format=csv&table=idempotency_keys")).status).toBe(400);
    expect((await download(business.ownerToken, "/export/data?format=csv&table=users;drop")).status).toBe(400);
    expect((await download(business.ownerToken, "/export/data?format=csv")).status).toBe(400);
  });

  it("is the owner's alone, and each download is written to the audit log", async () => {
    const business = await createTestBusiness();
    const manager = await inviteStaffWithPermissions(business, "Almost owner", ["customers.view", "settings.manage", "audit.view"]);
    expect((await download(manager.token, "/export/data")).status).toBe(403);
    expect((await download(manager.token, "/export/tables")).status).toBe(403);
    await (await download(business.ownerToken, "/export/data")).text();
    await download(business.ownerToken, "/export/data?format=csv&table=roles");
    const log = await callApi(business.ownerToken, "GET", "/audit-log?pageSize=100");
    const exports = log.body.data.filter((row: { entity: string }) => row.entity === "export");
    expect(exports.map((row: { after: { table: string } }) => row.after.table).sort()).toEqual(["all", "roles"]);
  });
});
