// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteTestStaff } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

integration("POS bootstrap, catalogue sync and held sales", { timeout: 180_000 }, () => {
  it("gives the till everything but the catalogue in one call, without costs or other data it should not see", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteTestStaff(business, "Cashier");
    const as = { terminalId: business.terminalId };
    const boot = await callApi(cashier.token, "GET", "/pos/bootstrap", as);
    expect(boot.status, JSON.stringify(boot.body)).toBe(200);
    expect(boot.body).toMatchObject({
      business: { id: business.businessId, tradeName: "Example Traders" },
      branch: { id: business.branchId, code: "KHI" },
      terminal: { id: business.terminalId, name: "Register 1", defaultPrintFormat: "pos80" },
      settings: { taxMode: "inclusive", cashRoundingPaisa: 0, allowNegativeStock: false },
      user: { roleName: "Cashier", maxDiscountBps: 500 },
      shift: null,
    });
    expect(boot.body.user.permissions).toContain("sales.create");
    expect(boot.body.paymentMethods.map((method: { code: string }) => method.code)).toEqual(["cash", "card", "bank_transfer", "jazzcash", "easypaisa"]);
    expect(boot.body.versions).toEqual(expect.objectContaining({ catalogue: expect.any(Number), reference: expect.any(Number) }));
    expect(JSON.stringify(boot.body)).not.toMatch(/fbrPos|pinHash|pin_hash/i);

    const opened = await callApi(cashier.token, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 100 }, idempotencyKey: key() });
    expect((await callApi(cashier.token, "GET", "/pos/bootstrap", as)).body.shift.id).toBe(opened.body.id);
  });

  it("sends only the products that changed since a version, archived ones included, and no costs to a cashier", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteTestStaff(business, "Cashier");
    const as = { terminalId: business.terminalId };
    const changes = (token: string, since: number) => callApi(token, "GET", `/pos/products/changes?since=${since}`, as);

    const empty = await changes(business.ownerToken, 0);
    expect(empty.body).toMatchObject({ hasMore: false, products: [] });

    const a = await createSimpleProduct(business, "A");
    const b = await createSimpleProduct(business, "B");
    const first = await changes(business.ownerToken, 0);
    expect(first.body.products.map((product: { id: string }) => product.id).sort()).toEqual([a.productId, b.productId].sort());
    expect(first.body.products[0].variants[0].costPaisa).toBe(100);
    const version = first.body.version as number;
    expect(version).toBeGreaterThan(0);

    expect((await changes(business.ownerToken, version)).body.products).toEqual([]);

    // Changing one product's price (a unit row) and archiving the other each show up once.
    const detail = await callApi(business.ownerToken, "GET", `/products/${a.productId}`);
    const body = {
      ...detail.body,
      variants: detail.body.variants.map((variant: { units: Array<{ salePricePaisa: number }> }) => ({
        ...variant, units: variant.units.map((unit) => ({ ...unit, salePricePaisa: unit.salePricePaisa + 100 })),
      })),
    };
    const updated = await callApi(business.ownerToken, "PUT", `/products/${a.productId}`, { body });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect((await callApi(business.ownerToken, "DELETE", `/products/${b.productId}`)).status).toBeLessThan(300);

    const delta = await changes(cashier.token, version);
    expect(delta.status).toBe(200);
    const byId = Object.fromEntries(delta.body.products.map((product: { id: string }) => [product.id, product]));
    expect(Object.keys(byId).sort()).toEqual([a.productId, b.productId].sort());
    expect(byId[b.productId].active).toBe(false);
    expect(byId[a.productId].variants[0].units[0].salePricePaisa).toBe(600);
    expect(byId[a.productId].variants[0]).not.toHaveProperty("costPaisa");
    expect(delta.body.version).toBeGreaterThan(version);
    expect((await changes(cashier.token, delta.body.version)).body.products).toEqual([]);

    const versions = await callApi(cashier.token, "GET", "/pos/data-versions", as);
    expect(versions.body.catalogue).toBe(delta.body.version);
  });

  it("holds a sale, lists it, and recalls it exactly once", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteTestStaff(business, "Cashier");
    const as = { terminalId: business.terminalId };
    const cart = { lines: [{ variantId: crypto.randomUUID(), quantity: "2" }], invoiceDiscount: null };

    const held = await callApi(cashier.token, "POST", "/held-sales", { ...as, body: { name: "Table 4", cart, totalPaisa: 1000 } });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    const list = await callApi(cashier.token, "GET", "/held-sales", as);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: "Table 4", totalPaisa: 1000 });
    expect(list.body[0]).not.toHaveProperty("cart");

    const recalled = await callApi(cashier.token, "POST", `/held-sales/${held.body.id}/recall`, as);
    expect(recalled.body.cart).toEqual(cart);
    expect((await callApi(cashier.token, "POST", `/held-sales/${held.body.id}/recall`, as)).status).toBe(404);
    expect((await callApi(cashier.token, "GET", "/held-sales", as)).body).toEqual([]);

    expect((await callApi(cashier.token, "POST", "/held-sales", { ...as, body: { cart: null, totalPaisa: 0 } })).status).toBe(400);
    const second = await callApi(cashier.token, "POST", "/held-sales", { ...as, body: { cart, totalPaisa: 5 } });
    expect((await callApi(cashier.token, "DELETE", `/held-sales/${second.body.id}`, as)).status).toBe(200);
    expect((await callApi(cashier.token, "DELETE", "/held-sales/not-an-id", as)).status).toBe(404);
  });
});
