// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const customer = (name: string, extra: Record<string, unknown> = {}) => ({ name, phone: "0300-1234567", ...extra });

integration("customers API", { timeout: 180_000 }, () => {
  it("creates, searches, edits and archives customers; the CNIC is for managers only", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteTestStaff(business, "Cashier");

    const created = await callApi(business.ownerToken, "POST", "/customers", {
      body: customer("Ali Traders", { businessName: "Ali & Sons", cnic: "42101-1234567-1", ntn: "1234567-8", registered: true, creditLimitPaisa: 5_000_000, termsDays: 30 }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ name: "Ali Traders", cnic: "4210112345671", registered: true, creditLimitPaisa: 5_000_000, termsDays: 30, active: true });
    expect(created.body).not.toHaveProperty("changeVersion");

    expect((await callApi(business.ownerToken, "POST", "/customers", { body: customer("Twin", { cnic: "4210112345671" }) })).body.error.code).toBe("CNIC_EXISTS");
    expect((await callApi(business.ownerToken, "POST", "/customers", { body: customer("Bad", { cnic: "123" }) })).status).toBe(400);
    expect((await callApi(business.ownerToken, "POST", "/customers", { body: { name: "", phone: "" } })).status).toBe(400);

    await callApi(business.ownerToken, "POST", "/customers", { body: customer("Bilal Store", { phone: "0321-5550000" }) });
    const found = await callApi(business.ownerToken, "GET", "/customers?q=5550000");
    expect(found.body.data.map((row: { name: string }) => row.name)).toEqual(["Bilal Store"]);
    expect((await callApi(business.ownerToken, "GET", "/customers?q=sons")).body.total).toBe(1);
    expect((await callApi(business.ownerToken, "GET", "/customers?pageSize=1")).body).toMatchObject({ total: 2, pageSize: 1 });

    // A cashier may look customers up but never sees the CNIC, and cannot edit.
    const seen = await callApi(cashier.token, "GET", `/customers/${created.body.id}`, { terminalId: business.terminalId });
    expect(seen.status).toBe(200);
    expect(seen.body).not.toHaveProperty("cnic");
    expect((await callApi(cashier.token, "PUT", `/customers/${created.body.id}`, { body: customer("Hacked") })).status).toBe(403);
    expect((await callApi(cashier.token, "DELETE", `/customers/${created.body.id}`)).status).toBe(403);
    expect((await callApi(cashier.token, "POST", "/customers", { body: customer("Nope") })).status).toBe(403);

    const edited = await callApi(business.ownerToken, "PUT", `/customers/${created.body.id}`, { body: customer("Ali Traders Ltd", { cnic: "4210112345671", termsDays: 45 }) });
    expect(edited.body).toMatchObject({ name: "Ali Traders Ltd", termsDays: 45, creditLimitPaisa: 0 });

    expect((await callApi(business.ownerToken, "DELETE", `/customers/${created.body.id}`)).body).toMatchObject({ active: false });
    expect((await callApi(business.ownerToken, "GET", "/customers")).body.total).toBe(1);
    expect((await callApi(business.ownerToken, "GET", "/customers?active=all")).body.total).toBe(2);
    expect((await callApi(business.ownerToken, "GET", "/customers/not-an-id")).status).toBe(404);

    const audit = await callApi(business.ownerToken, "GET", "/audit-log?pageSize=100");
    const entries = audit.body.data.filter((row: { entity: string }) => row.entity === "customer");
    expect(entries.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(entries)).not.toContain("4210112345671");
  });

  it("lets a cashier add a customer at the till with only a name and a phone", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteTestStaff(business, "Cashier");
    const quick = await callApi(cashier.token, "POST", "/customers/quick", { body: { name: "Walk-in regular", phone: "0300 1112223" }, terminalId: business.terminalId });
    expect(quick.status, JSON.stringify(quick.body)).toBe(201);
    expect(quick.body).toMatchObject({ name: "Walk-in regular", creditLimitPaisa: 0, registered: false });
    expect((await callApi(cashier.token, "POST", "/customers/quick", { body: { name: "No phone", phone: "" } })).status).toBe(400);
  });

  it("keeps areas and groups, rejects other businesses' references, and names duplicates", async () => {
    const business = await createTestBusiness();
    const other = await createTestBusiness();
    const area = await callApi(business.ownerToken, "POST", "/areas", { body: { name: "Saddar" } });
    expect(area.status).toBe(201);
    expect((await callApi(business.ownerToken, "POST", "/areas", { body: { name: "saddar" } })).body.error.code).toBe("NAME_EXISTS");
    const list = await callApi(business.ownerToken, "POST", "/price-lists", { body: { name: "Wholesale", items: [] } });
    const group = await callApi(business.ownerToken, "POST", "/customer-groups", { body: { name: "Wholesalers", priceListId: list.body.id } });
    expect(group.status, JSON.stringify(group.body)).toBe(201);
    expect((await callApi(business.ownerToken, "POST", "/customer-groups", { body: { name: "Bad", priceListId: crypto.randomUUID() } })).body.error.code).toBe("INVALID_REFERENCE");

    const foreignArea = await callApi(other.ownerToken, "POST", "/areas", { body: { name: "Elsewhere" } });
    const bad = await callApi(business.ownerToken, "POST", "/customers", { body: customer("X", { areaId: foreignArea.body.id }) });
    expect(bad.status).toBe(400);
    const ok = await callApi(business.ownerToken, "POST", "/customers", { body: customer("Y", { areaId: area.body.id, groupId: group.body.id }) });
    expect(ok.status).toBe(201);
    expect((await callApi(business.ownerToken, "GET", `/customers?groupId=${group.body.id}`)).body.total).toBe(1);
    expect((await callApi(other.ownerToken, "GET", `/customers/${ok.body.id}`)).status).toBe(404);
  });

  it("syncs customers to the till by version, with the tier resolved and no CNIC, notes or email", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteTestStaff(business, "Cashier");
    const as = { terminalId: business.terminalId };
    const changes = (since: number) => callApi(cashier.token, "GET", `/pos/customers/changes?since=${since}`, as);
    expect((await changes(0)).body).toMatchObject({ customers: [], hasMore: false });

    const list = await callApi(business.ownerToken, "POST", "/price-lists", { body: { name: "Wholesale", items: [] } });
    const group = await callApi(business.ownerToken, "POST", "/customer-groups", { body: { name: "Wholesalers", priceListId: list.body.id } });
    const a = await callApi(business.ownerToken, "POST", "/customers", { body: customer("Grouped", { groupId: group.body.id, cnic: "4210112345671", notes: "secret", email: "a@b.pk" }) });
    await callApi(business.ownerToken, "POST", "/customers", { body: customer("Plain") });
    const first = await changes(0);
    expect(first.body.customers).toHaveLength(2);
    const grouped = first.body.customers.find((row: { name: string }) => row.name === "Grouped");
    expect(grouped.priceListId).toBe(list.body.id);
    expect(JSON.stringify(first.body)).not.toMatch(/4210112345671|secret|a@b\.pk|cnic|notes/);
    const version = first.body.version as number;
    expect((await changes(version)).body.customers).toEqual([]);

    // Changing the group's tier reaches the customers in it; archiving shows up as inactive.
    const other = await callApi(business.ownerToken, "POST", "/price-lists", { body: { name: "Retail+", items: [] } });
    await callApi(business.ownerToken, "PUT", `/customer-groups/${group.body.id}`, { body: { name: "Wholesalers", priceListId: other.body.id } });
    await callApi(business.ownerToken, "DELETE", `/customers/${a.body.id}`);
    const delta = await changes(version);
    expect(delta.body.customers.map((row: { name: string; active: boolean }) => [row.name, row.active])).toEqual([["Grouped", false]]);
    expect(delta.body.customers[0].priceListId).toBe(other.body.id);
    expect(delta.body.version).toBeGreaterThan(version);
    expect((await callApi(cashier.token, "GET", "/pos/data-versions", as)).body.customers).toBe(delta.body.version);
  });

  it("sells at the customer's tier: group list, quantity break, own list first, override still needs permission", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteTestStaff(business, "Cashier");
    const product = await createSimpleProduct(business, "T-1", 100);
    await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nT-1,1000,Piece,1.00" }, idempotencyKey: key() });
    const wholesale = await callApi(business.ownerToken, "POST", "/price-lists", {
      body: { name: "Wholesale", items: [
        { variantId: product.variantId, unitId: product.pieceId, minQuantity: "1", pricePaisa: 450 },
        { variantId: product.variantId, unitId: product.pieceId, minQuantity: "100", pricePaisa: 400 },
      ] },
    });
    expect(wholesale.status, JSON.stringify(wholesale.body)).toBe(201);
    const vip = await callApi(business.ownerToken, "POST", "/price-lists", {
      body: { name: "VIP", items: [{ variantId: product.variantId, unitId: product.pieceId, minQuantity: "1", pricePaisa: 300 }] },
    });
    const group = await callApi(business.ownerToken, "POST", "/customer-groups", { body: { name: "Wholesalers", priceListId: wholesale.body.id } });
    const viaGroup = await callApi(business.ownerToken, "POST", "/customers", { body: customer("Via group", { groupId: group.body.id }) });
    const own = await callApi(business.ownerToken, "POST", "/customers", { body: customer("Own list", { groupId: group.body.id, priceListId: vip.body.id }) });
    const as = { terminalId: business.terminalId };
    const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
    const client = sql();
    const [cash] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${business.businessId} AND code = 'cash'`;
    await client.end();

    const sell = (token: string, customerId: string | null, quantity: string, total: number, extra: Record<string, unknown> = {}) => callApi(token, "POST", "/sales", {
      ...as, idempotencyKey: key(),
      body: { shiftId: shift.body.id, customerId, lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity, ...extra }], payments: [{ methodId: cash.id, amountPaisa: total }] },
    });

    const shelf = await sell(business.ownerToken, null, "2", 1000);
    expect(shelf.body.invoice.totalPaisa).toBe(1000);
    const tier = await sell(business.ownerToken, viaGroup.body.id, "2", 900);
    expect(tier.status, JSON.stringify(tier.body)).toBe(201);
    expect(tier.body.invoice.lines[0].unitPricePaisa).toBe(450);
    const bulk = await sell(business.ownerToken, viaGroup.body.id, "100", 40000);
    expect(bulk.body.invoice.lines[0].unitPricePaisa).toBe(400);
    const ownTier = await sell(business.ownerToken, own.body.id, "2", 600);
    expect(ownTier.body.invoice.lines[0].unitPricePaisa).toBe(300);
    const client2 = sql();
    const [row] = await client2<{ customer_id: string }[]>`SELECT customer_id FROM sales_invoices WHERE id = ${tier.body.invoice.id}`;
    await client2.end();
    expect(row.customer_id).toBe(viaGroup.body.id);

    // Sending the tier price as the line price is not an override; any other price is, and a cashier may not.
    expect((await sell(cashier.token, viaGroup.body.id, "2", 900, { unitPricePaisa: 450 })).status).toBe(201);
    const denied = await sell(cashier.token, viaGroup.body.id, "2", 800, { unitPricePaisa: 400 });
    expect(denied.body.error.code).toBe("PRICE_OVERRIDE_DENIED");

    expect((await sell(business.ownerToken, crypto.randomUUID(), "1", 500)).body.error.code).toBe("INVALID_CUSTOMER");
    await callApi(business.ownerToken, "DELETE", `/customers/${viaGroup.body.id}`);
    expect((await sell(business.ownerToken, viaGroup.body.id, "1", 500)).body.error.code).toBe("INVALID_CUSTOMER");

    const items = await callApi(cashier.token, "GET", `/pos/price-lists/${wholesale.body.id}`, as);
    expect(items.body.items.map((item: { minQuantity: string; pricePaisa: number }) => [item.minQuantity, item.pricePaisa]).sort()).toEqual([["1", 450], ["100", 400]]);
    expect((await callApi(cashier.token, "GET", `/pos/price-lists/${crypto.randomUUID()}`, as)).status).toBe(404);
  });
});
