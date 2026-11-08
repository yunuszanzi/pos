// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createTestBusiness, hasLocalStack, inviteTestStaff, type TestBusiness } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

// v0.5 slice 1 against the real API and database: suppliers, their ledger, opening payables and payables ageing.

async function newSupplier(business: TestBusiness, name: string, extra: Record<string, unknown> = {}) {
  const created = await callApi(business.ownerToken, "POST", "/suppliers", { body: { name, ...extra } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.id as string;
}
const importPayables = (business: TestBusiness, csv: string, token = business.ownerToken) =>
  callApi(token, "POST", "/suppliers-opening-balances", { body: { csv }, idempotencyKey: key() });

integration("suppliers", { timeout: 120_000 }, () => {
  it("adds, edits, finds and archives suppliers; the name is unique", async () => {
    const business = await createTestBusiness();
    const id = await newSupplier(business, "Karachi Balloon Mills", { phone: "0300-1112222", contactPerson: "Imran", termsDays: 30, ntn: "1234567-8", registered: true });
    expect((await callApi(business.ownerToken, "GET", `/suppliers/${id}`)).body).toMatchObject({ name: "Karachi Balloon Mills", termsDays: 30, ntn: "1234567-8", balancePaisa: 0, active: true });

    const duplicate = await callApi(business.ownerToken, "POST", "/suppliers", { body: { name: " karachi balloon mills " } });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("NAME_EXISTS");
    expect((await callApi(business.ownerToken, "POST", "/suppliers", { body: { name: "" } })).status).toBe(400);
    expect((await callApi(business.ownerToken, "POST", "/suppliers", { body: { name: "Bad", phone: "abc" } })).status).toBe(400);

    const updated = await callApi(business.ownerToken, "PUT", `/suppliers/${id}`, { body: { name: "Karachi Balloon Mills Ltd", phone: "0300-1112222", termsDays: 45 } });
    expect(updated.body).toMatchObject({ name: "Karachi Balloon Mills Ltd", termsDays: 45 });
    await newSupplier(business, "Lahore Packaging");

    const found = await callApi(business.ownerToken, "GET", "/suppliers?q=0300-111");
    expect(found.body.data.map((row: { name: string }) => row.name)).toEqual(["Karachi Balloon Mills Ltd"]);
    const paged = await callApi(business.ownerToken, "GET", "/suppliers?pageSize=1&page=2");
    expect(paged.body).toMatchObject({ total: 2, page: 2 });
    expect(paged.body.data).toHaveLength(1);

    expect((await callApi(business.ownerToken, "DELETE", `/suppliers/${id}`)).body).toEqual({ id, active: false });
    expect((await callApi(business.ownerToken, "GET", "/suppliers")).body.total).toBe(1);
    expect((await callApi(business.ownerToken, "GET", "/suppliers?active=all")).body.total).toBe(2);
    expect((await callApi(business.ownerToken, "GET", "/suppliers/not-an-id")).status).toBe(404);
    expect((await callApi(business.ownerToken, "PUT", `/suppliers/${crypto.randomUUID()}`, { body: { name: "Nobody" } })).status).toBe(404);
  });

  it("loads opening payables: owed to the supplier is a credit in their ledger, all or nothing and once", async () => {
    const business = await createTestBusiness();
    const owed = await newSupplier(business, "We Owe Them", { phone: "0300-1111111" });
    const held = await newSupplier(business, "They Owe Us", { phone: "0311-2222222" });
    await newSupplier(business, "Twin");
    await newSupplier(business, "Twin2");

    const preview = await callApi(business.ownerToken, "POST", "/suppliers-opening-balances/preview", {
      body: { csv: "supplier,phone,balance,date,note\nWe Owe Them,,250000.00,,Unpaid bills\n,0311-2222222,-5000.00,,Advance paid\n" },
    });
    expect(preview.body).toMatchObject({ canImport: true, summary: { suppliers: 2, owedPaisa: 25_000_000, creditPaisa: 500_000 } });

    const bad = await importPayables(business, "supplier,balance\nWe Owe Them,10.00\nNobody,5.00\n");
    expect(bad.status).toBe(422);
    expect(bad.body.error.details).toMatchObject([{ row: 3, field: "supplier" }]);
    expect((await callApi(business.ownerToken, "GET", `/suppliers/${owed}`)).body.balancePaisa).toBe(0);
    // A customer-style column is not accepted for suppliers.
    expect((await importPayables(business, "customer,balance\nWe Owe Them,10.00\n")).status).toBe(422);

    const done = await importPayables(business, "supplier,phone,balance,date,note\nWe Owe Them,,250000.00,,Unpaid bills\n,0311-2222222,-5000.00,,Advance paid\n");
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toEqual({ suppliers: 2, owedPaisa: 25_000_000, creditPaisa: 500_000 });

    const owedLedger = (await callApi(business.ownerToken, "GET", `/suppliers/${owed}/ledger`)).body;
    expect(owedLedger.supplier.balancePaisa).toBe(25_000_000);
    expect(owedLedger.entries).toMatchObject([{ docType: "opening_balance", memo: "Unpaid bills", creditPaisa: 25_000_000, debitPaisa: 0, balanceAfterPaisa: 25_000_000 }]);
    expect((await callApi(business.ownerToken, "GET", `/suppliers/${held}/ledger`)).body.supplier.balancePaisa).toBe(-500_000);

    const again = await importPayables(business, "supplier,balance\nWe Owe Them,1.00\n");
    expect(again.status).toBe(422);
    expect(again.body.error.details[0].message).toMatch(/already has entries/);
  });

  it("ages what is owed by the date of the debt, and totals it", async () => {
    const business = await createTestBusiness();
    await newSupplier(business, "Old Bills", { termsDays: 30 });
    await newSupplier(business, "Recent Bills", { termsDays: 60 });
    await newSupplier(business, "Advance Given");
    await newSupplier(business, "Square");
    const loaded = await importPayables(business, `supplier,balance,date\nOld Bills,800.00,${daysAgo(100)}\nRecent Bills,200.00,${daysAgo(40)}\nAdvance Given,-50.00,${daysAgo(5)}\n`);
    expect(loaded.status, JSON.stringify(loaded.body)).toBe(201);

    const report = await callApi(business.ownerToken, "GET", "/supplier-ageing");
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const byName = Object.fromEntries(report.body.data.map((row: { name: string }) => [row.name, row]));
    expect(byName["Old Bills"]).toMatchObject({ bandsPaisa: [0, 0, 0, 80_000], owedPaisa: 80_000, overdue: true });
    expect(byName["Recent Bills"]).toMatchObject({ bandsPaisa: [0, 20_000, 0, 0], overdue: false }); // 40 days, terms 60
    expect(byName["Advance Given"]).toBeUndefined(); // credit with them is not a debt
    expect(byName.Square).toBeUndefined();
    expect(report.body.totals).toEqual({ bandsPaisa: [0, 20_000, 0, 80_000], owedPaisa: 100_000 });
    expect(report.body.data[0].name).toBe("Old Bills");

    const overdue = await callApi(business.ownerToken, "GET", "/supplier-ageing?overdue=true");
    expect(overdue.body.data.map((row: { name: string }) => row.name)).toEqual(["Old Bills"]);
    expect((await callApi(business.ownerToken, "GET", "/supplier-ageing?q=recent")).body.total).toBe(1);
    expect((await callApi(business.ownerToken, "GET", "/supplier-ageing?pageSize=1&page=2")).body.data).toHaveLength(1);
  });

  it("checks permissions and hides what is owed from people who may not see the ledger", async () => {
    const business = await createTestBusiness();
    const id = await newSupplier(business, "Guarded Supplier");
    const cashier = await inviteTestStaff(business, "Cashier");
    expect((await callApi(cashier.token, "GET", "/suppliers")).status).toBe(403); // cashiers hold no supplier permissions
    expect((await callApi(cashier.token, "GET", `/suppliers/${id}/ledger`)).status).toBe(403);
    expect((await callApi(cashier.token, "POST", "/suppliers", { body: { name: "Sneaky" } })).status).toBe(403);
    expect((await callApi(cashier.token, "GET", "/supplier-ageing")).status).toBe(403);
    expect((await importPayables(business, "supplier,balance\nGuarded Supplier,1.00\n", cashier.token)).status).toBe(403);
    expect((await callApi("", "GET", "/suppliers")).status).toBe(401);
  });
});
