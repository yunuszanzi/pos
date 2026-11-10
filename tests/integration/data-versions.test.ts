// @vitest-environment node
import { describe, expect, it } from "vitest";
import { allPermissionKeys, cashierPermissionKeys, managerPermissionKeys } from "../../shared/permissions";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteTestStaff, sql, type TestBusiness } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

type Db = ReturnType<typeof sql>;

async function versions(client: Db, business: TestBusiness) {
  const rows = await client<{ dataset: string; version: string }[]>`SELECT dataset, version FROM data_versions WHERE business_id = ${business.businessId}`;
  return Object.fromEntries(rows.map((row) => [row.dataset, Number(row.version)]));
}

async function productVersion(client: Db, productId: string) {
  const [row] = await client<{ catalog_version: string }[]>`SELECT catalog_version FROM products WHERE id = ${productId}`;
  return Number(row.catalog_version);
}

integration("change counters for the POS cache", { timeout: 90_000 }, () => {
  it("stamps a product when it, or one of its SKUs or units, changes, and leaves the others alone", async () => {
    const business = await createTestBusiness();
    const first = await createSimpleProduct(business, "V-1");
    const second = await createSimpleProduct(business, "V-2");
    const client = sql();
    try {
      const a = await productVersion(client, first.productId);
      const b = await productVersion(client, second.productId);
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(a);

      // A price change is a change to a unit, two levels down.
      await client`UPDATE product_units SET sale_price_paisa = 999 WHERE variant_id = ${first.variantId} AND is_base`;
      const afterPrice = await productVersion(client, first.productId);
      expect(afterPrice).toBeGreaterThan(b);
      expect(await productVersion(client, second.productId)).toBe(b);

      // So is a cost, a SKU name, and a new barcode.
      await client`UPDATE product_variants SET cost_paisa = 777 WHERE id = ${first.variantId}`;
      const afterCost = await productVersion(client, first.productId);
      expect(afterCost).toBeGreaterThan(afterPrice);
      await client`UPDATE products SET name = 'Renamed' WHERE id = ${second.productId}`;
      expect(await productVersion(client, second.productId)).toBeGreaterThan(afterCost);
    } finally {
      await client.end();
    }
  });

  it("keeps an archived product in the changes, as inactive, so a terminal can drop it", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "V-3");
    const client = sql();
    try {
      const before = await productVersion(client, product.productId);
      expect((await callApi(business.ownerToken, "DELETE", `/products/${product.productId}`)).status).toBe(200);
      const [row] = await client<{ active: boolean; catalog_version: string }[]>`SELECT active, catalog_version FROM products WHERE id = ${product.productId}`;
      expect(row.active).toBe(false);
      expect(Number(row.catalog_version)).toBeGreaterThan(before);
    } finally {
      await client.end();
    }
  });

  it("gives everything changed in one transaction a single version", async () => {
    const business = await createTestBusiness();
    const csv = ["sku,name,sale_price", "B-1,Alpha,10", "B-2,Beta,20", "B-3,Gamma,30"].join("\n");
    const imported = await callApi(business.ownerToken, "POST", "/products/import", { body: { csv }, idempotencyKey: `import-${crypto.randomUUID()}` });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    const client = sql();
    try {
      const rows = await client<{ catalog_version: string }[]>`SELECT catalog_version FROM products WHERE business_id = ${business.businessId}`;
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.catalog_version)).size).toBe(1);
      expect((await versions(client, business)).catalogue).toBe(Number(rows[0].catalog_version));
    } finally {
      await client.end();
    }
  });

  it("does not use up a version when the transaction is rolled back", async () => {
    const business = await createTestBusiness();
    await createSimpleProduct(business, "V-4");
    const client = sql();
    try {
      const before = (await versions(client, business)).catalogue;
      const [unit] = await client<{ id: string }[]>`SELECT id FROM units WHERE business_id = ${business.businessId} AND name = 'Piece'`;
      await expect(client.begin(async (transaction) => {
        await transaction`INSERT INTO products (business_id, name, base_unit_id) VALUES (${business.businessId}, 'Ghost', ${unit.id})`;
        throw new Error("rolled back");
      })).rejects.toThrow(/rolled back/);
      expect((await versions(client, business)).catalogue).toBe(before);
      expect(await client`SELECT 1 FROM products WHERE name = 'Ghost' AND business_id = ${business.businessId}`).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("hands out versions in commit order: a change cannot appear with a lower version than one already seen", async () => {
    const business = await createTestBusiness();
    await createSimpleProduct(business, "V-5");
    const setup = sql();
    const first = sql();
    const second = sql();
    try {
      const [unit] = await setup<{ id: string }[]>`SELECT id FROM units WHERE business_id = ${business.businessId} AND name = 'Piece'`;
      let releaseFirst!: () => void;
      const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstTook!: () => void;
      const took = new Promise<void>((resolve) => { firstTook = resolve; });

      const firstDone = first.begin(async (transaction) => {
        await transaction`INSERT INTO products (business_id, name, base_unit_id) VALUES (${business.businessId}, 'First', ${unit.id})`;
        firstTook();
        await held;
      });
      await took;
      let secondFinished = false;
      const secondDone = second.begin(async (transaction) => {
        await transaction`INSERT INTO products (business_id, name, base_unit_id) VALUES (${business.businessId}, 'Second', ${unit.id})`;
      }).then(() => { secondFinished = true; });

      // The second writer has to wait for the first to commit before it can take the next version.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(secondFinished).toBe(false);
      releaseFirst();
      await Promise.all([firstDone, secondDone]);

      const rows = await setup<{ name: string; catalog_version: string }[]>`SELECT name, catalog_version FROM products WHERE name IN ('First', 'Second') AND business_id = ${business.businessId}`;
      const byName = Object.fromEntries(rows.map((row) => [row.name, Number(row.catalog_version)]));
      expect(byName.First).toBeLessThan(byName.Second);
    } finally {
      await Promise.all([setup.end(), first.end(), second.end()]);
    }
  });

  it("counts reference, settings and access changes separately, per business", async () => {
    const shopA = await createTestBusiness();
    const shopB = await createTestBusiness();
    const client = sql();
    try {
      const beforeA = await versions(client, shopA);
      const beforeB = await versions(client, shopB);

      expect((await callApi(shopA.ownerToken, "POST", "/categories", { body: { name: "Toys" } })).status).toBe(201);
      let now = await versions(client, shopA);
      expect(now.reference).toBeGreaterThan(beforeA.reference);
      expect(now.settings).toBe(beforeA.settings);

      const settings = await callApi(shopA.ownerToken, "GET", "/settings");
      await callApi(shopA.ownerToken, "PUT", "/settings", { body: { ...settings.body, dateFormat: "yyyy-MM-dd" } });
      const afterSettings = await versions(client, shopA);
      expect(afterSettings.settings).toBeGreaterThan(now.settings);
      now = afterSettings;

      const role = await callApi(shopA.ownerToken, "POST", "/roles", { body: { name: "Counter", permissionKeys: ["catalog.view"] } });
      expect(role.status).toBe(201);
      const afterRole = await versions(client, shopA);
      expect(afterRole.access).toBeGreaterThan(now.access);
      await callApi(shopA.ownerToken, "PUT", `/roles/${role.body.id}`, { body: { name: "Counter", permissionKeys: ["catalog.view", "inventory.view"] } });
      expect((await versions(client, shopA)).access).toBeGreaterThan(afterRole.access);

      // Another business is untouched.
      expect(await versions(client, shopB)).toEqual(beforeB);
    } finally {
      await client.end();
    }
  });
});

integration("what a new business and a new branch start with", { timeout: 90_000 }, () => {
  it("gives a new business payment methods, discount limits and the sales permissions", async () => {
    const business = await createTestBusiness();
    const client = sql();
    try {
      const methods = await client<{ code: string; kind: string; active: boolean }[]>`SELECT code, kind, active FROM payment_methods WHERE business_id = ${business.businessId} ORDER BY sort_order`;
      expect(methods.map((method) => [method.code, method.kind])).toEqual([["cash", "cash"], ["card", "card"], ["bank_transfer", "bank"], ["jazzcash", "wallet"], ["easypaisa", "wallet"]]);
      expect(methods.every((method) => method.active)).toBe(true);

      const roles = await client<{ name: string; max_discount_bps: number }[]>`SELECT name, max_discount_bps FROM roles WHERE business_id = ${business.businessId}`;
      expect(Object.fromEntries(roles.map((role) => [role.name, role.max_discount_bps]))).toEqual({ Owner: 10000, Manager: 10000, Cashier: 500 });

      const granted = async (roleId: string) => (await client<{ permission_key: string }[]>`SELECT permission_key FROM role_permissions WHERE role_id = ${roleId}`).map((row) => row.permission_key).sort();
      expect(await granted(business.roleIds.Cashier)).toEqual([...cashierPermissionKeys].sort());
      expect(await granted(business.roleIds.Manager)).toEqual([...managerPermissionKeys].sort());
      expect(await granted(business.roleIds.Owner)).toEqual([...allPermissionKeys].sort());
      expect(cashierPermissionKeys).toEqual(expect.arrayContaining(["sales.create", "shifts.open", "shifts.close", "cash.movement"]));
      expect(cashierPermissionKeys).not.toContain("sales.price_override");
      expect(cashierPermissionKeys).not.toContain("sales.discount.above_limit");
      expect(cashierPermissionKeys).not.toContain("shifts.view_all");

      const [series] = await client<{ prefix: string; next_number: number }[]>`SELECT prefix, next_number FROM document_series WHERE business_id = ${business.businessId} AND branch_id = ${business.branchId} AND doc_type = 'invoice'`;
      expect(series).toEqual({ prefix: "INV-KHI", next_number: 1 });
    } finally {
      await client.end();
    }
  });

  it("gives every new branch its own invoice numbering, and refuses a duplicate branch code", async () => {
    const business = await createTestBusiness();
    const client = sql();
    try {
      const branch = await callApi(business.ownerToken, "POST", "/branches", { body: { name: "Hyderabad", code: "hyd" } });
      expect(branch.status).toBe(201);
      const [series] = await client<{ prefix: string; next_number: number }[]>`SELECT prefix, next_number FROM document_series WHERE branch_id = ${branch.body.id} AND doc_type = 'invoice'`;
      expect(series).toEqual({ prefix: "INV-HYD", next_number: 1 });

      const duplicate = await callApi(business.ownerToken, "POST", "/branches", { body: { name: "Hyderabad 2", code: "hyd" } });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error).toMatchObject({ code: "CODE_EXISTS", message: "A branch with this code already exists" });
      expect(await client`SELECT 1 FROM branches WHERE business_id = ${business.businessId} AND lower(code) = 'hyd'`).toHaveLength(1);
      expect(await client`SELECT 1 FROM document_series WHERE business_id = ${business.businessId} AND prefix = 'INV-HYD'`).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it("stores the selling settings and refuses values that make no sense", async () => {
    const business = await createTestBusiness();
    const settings = await callApi(business.ownerToken, "GET", "/settings");
    expect(settings.body).toMatchObject({ taxMode: "inclusive", cashRoundingPaisa: 0, allowNegativeStock: false, autoPrintReceipt: true });

    const changed = await callApi(business.ownerToken, "PUT", "/settings", {
      body: { ...settings.body, taxMode: "exclusive", cashRoundingPaisa: 500, allowNegativeStock: true, autoPrintReceipt: false },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ taxMode: "exclusive", cashRoundingPaisa: 500, allowNegativeStock: true, autoPrintReceipt: false });

    for (const bad of [{ cashRoundingPaisa: 250 }, { taxMode: "included" }, { allowNegativeStock: "yes" }]) {
      expect((await callApi(business.ownerToken, "PUT", "/settings", { body: { ...settings.body, ...bad } })).status, JSON.stringify(bad)).toBe(400);
    }
    const cashier = await inviteTestStaff(business, "Cashier");
    expect((await callApi(cashier.token, "PUT", "/settings", { body: settings.body })).status).toBe(403);
  });
});
