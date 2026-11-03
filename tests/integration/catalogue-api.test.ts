// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createTestBusiness, hasLocalStack, inviteTestStaff, type TestBusiness } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

type Named = { id: string; name: string };

async function lookups(business: TestBusiness) {
  const [units, taxes] = await Promise.all([
    callApi<Named[]>(business.ownerToken, "GET", "/units"),
    callApi<Named[]>(business.ownerToken, "GET", "/tax-categories"),
  ]);
  const unit = (name: string) => units.body.find((row) => row.name === name)!.id;
  return { piece: unit("Piece"), carton: unit("Carton"), pack: unit("Pack"), standardTax: taxes.body.find((row) => row.name.startsWith("Standard"))!.id };
}

function productBody(ids: Awaited<ReturnType<typeof lookups>>, overrides: Record<string, unknown> = {}, sku = "BAL-12-RED") {
  return {
    name: "Latex Balloon 12 inch",
    taxCategoryId: ids.standardTax,
    hsCode: "9503.0090",
    baseUnitId: ids.piece,
    variants: [{
      sku,
      variantName: "Red",
      costPaisa: 320,
      reorderLevel: "500",
      units: [
        { unitId: ids.piece, factorToBase: "1", barcode: `${sku}-PC`, salePricePaisa: 500 },
        { unitId: ids.carton, factorToBase: "1000", barcode: `${sku}-CTN`, salePricePaisa: 450000 },
      ],
    }],
    ...overrides,
  };
}

async function createProduct(business: TestBusiness, body: unknown) {
  const response = await callApi(business.ownerToken, "POST", "/products", { body });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

const csv = (...lines: string[]) => lines.join("\n");
const importKey = () => `import-${crypto.randomUUID()}`;
async function importCsv(business: TestBusiness, text: string, key = importKey(), token = business.ownerToken) {
  const response = await callApi(token, "POST", "/products/import", { body: { csv: text }, idempotencyKey: key });
  return { status: response.status, body: response.body, replayed: response.headers.get("Idempotent-Replay") === "true" };
}

integration("catalogue API", { timeout: 120_000 }, () => {
  it("lets a cashier read the catalogue but nothing else", async () => {
    const business = await createTestBusiness();
    const ids = await lookups(business);
    const product = await createProduct(business, productBody(ids));
    const cashier = await inviteTestStaff(business, "Cashier");

    for (const path of ["/products", `/products/${product.id}`, "/categories", "/brands", "/units", "/tax-categories", "/price-lists", "/products/lookup?barcode=BAL-12-RED-PC"]) {
      expect((await callApi(cashier.token, "GET", path)).status, path).toBe(200);
    }
    for (const [method, path, body] of [
      ["POST", "/products", productBody(ids, {}, "X1")], ["PUT", `/products/${product.id}`, productBody(ids)], ["DELETE", `/products/${product.id}`, undefined],
      ["POST", "/categories", { name: "Hack" }], ["POST", "/brands", { name: "Hack" }], ["POST", "/units", { name: "Hack", shortName: "h" }],
      ["PUT", `/tax-categories/${ids.standardTax}`, { rateBps: 0 }], ["POST", "/price-lists", { name: "Hack" }],
      ["GET", "/products/export", undefined], ["POST", "/products/import/preview", { csv: "sku,name\nA,B" }],
    ] as const) {
      const response = await callApi(cashier.token, method, path, { body });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect((await importCsv(business, "sku,name\nA,B", importKey(), cashier.token)).status).toBe(403);
  });

  it("creates a product with units, finds it by any barcode and converts cartons to pieces", async () => {
    const business = await createTestBusiness();
    const ids = await lookups(business);
    const product = await createProduct(business, productBody(ids));
    expect(product.variants[0].units.map((unit: { isBase: boolean; factorToBase: string }) => [unit.isBase, unit.factorToBase])).toEqual([[true, "1"], [false, "1000"]]);
    expect(product.variants[0].costPaisa).toBe(320);

    const carton = await callApi(business.ownerToken, "GET", "/products/lookup?barcode=BAL-12-RED-CTN");
    expect(carton.status).toBe(200);
    expect(carton.body).toMatchObject({ variantId: product.variants[0].id, unitId: ids.carton, factorToBase: "1000" });
    expect(carton.body.product.id).toBe(product.id);
    expect((await callApi(business.ownerToken, "GET", "/products/lookup?barcode=NOPE")).status).toBe(404);
    expect((await callApi(business.ownerToken, "GET", "/products/lookup")).status).toBe(400);
  });

  it("rejects duplicate SKUs and barcodes, bad references and malformed products", async () => {
    const shopA = await createTestBusiness();
    const shopB = await createTestBusiness();
    const idsA = await lookups(shopA);
    const idsB = await lookups(shopB);
    await createProduct(shopA, productBody(idsA));

    const sameSku = await callApi(shopA.ownerToken, "POST", "/products", { body: productBody(idsA, { name: "Other" }, "bal-12-red") });
    expect(sameSku.status).toBe(409);
    expect(sameSku.body.error).toMatchObject({ code: "SKU_EXISTS" });

    const sameBarcode = productBody(idsA, { name: "Other" }, "NEW-SKU");
    sameBarcode.variants[0].units[0].barcode = "BAL-12-RED-PC";
    const clash = await callApi(shopA.ownerToken, "POST", "/products", { body: sameBarcode });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatchObject({ code: "BARCODE_EXISTS", message: "Barcode BAL-12-RED-PC is already used by another product" });

    // Another business may use the same SKU and barcode.
    expect((await callApi(shopB.ownerToken, "POST", "/products", { body: productBody(idsB) })).status).toBe(201);
    // ...but cannot reference shop A's units or tax categories.
    const foreign = await callApi(shopB.ownerToken, "POST", "/products", { body: productBody(idsA, {}, "FOREIGN") });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe("INVALID_REFERENCE");

    const noBase = productBody(idsA, {}, "NO-BASE");
    noBase.variants[0].units = noBase.variants[0].units.slice(1);
    const missingBase = await callApi(shopA.ownerToken, "POST", "/products", { body: noBase });
    expect(missingBase.status).toBe(400);
    expect(missingBase.body.error.message).toContain("base unit");
    expect((await callApi(shopA.ownerToken, "POST", "/products", { body: { ...productBody(idsA, {}, "EMPTY"), variants: [] } })).status).toBe(400);
  });

  it("keeps tenants apart and answers 404 for unknown or malformed ids", async () => {
    const shopA = await createTestBusiness();
    const shopB = await createTestBusiness();
    const product = await createProduct(shopA, productBody(await lookups(shopA)));

    expect((await callApi(shopB.ownerToken, "GET", `/products/${product.id}`)).status).toBe(404);
    expect((await callApi(shopB.ownerToken, "DELETE", `/products/${product.id}`)).status).toBe(404);
    expect((await callApi(shopB.ownerToken, "GET", "/products/lookup?barcode=BAL-12-RED-PC")).status).toBe(404);
    expect((await callApi(shopB.ownerToken, "GET", "/products")).body.total).toBe(0);
    expect((await callApi(shopA.ownerToken, "GET", "/products/not-a-uuid")).status).toBe(404);
    expect((await callApi(shopA.ownerToken, "PUT", "/categories/not-a-uuid", { body: { name: "x" } })).status).toBe(404);
    expect((await callApi(shopA.ownerToken, "GET", `/products/${product.id}`)).status).toBe(200);
  });

  it("hides cost prices from roles without products.cost.view and never overwrites them", async () => {
    const business = await createTestBusiness();
    const ids = await lookups(business);
    const product = await createProduct(business, productBody(ids));
    const editor = await callApi(business.ownerToken, "POST", "/roles", { body: { name: "Catalogue editor", permissionKeys: ["catalog.view", "catalog.manage"] } });
    business.roleIds["Catalogue editor"] = editor.body.id;
    const staff = await inviteTestStaff(business, "Catalogue editor");

    const seen = await callApi(staff.token, "GET", `/products/${product.id}`);
    expect(seen.body.variants[0]).not.toHaveProperty("costPaisa");
    expect((await callApi(staff.token, "GET", "/products")).body.data[0].variants[0]).not.toHaveProperty("costPaisa");

    const update = productBody(ids, { name: "Renamed" });
    update.variants[0] = { ...update.variants[0], id: product.variants[0].id, costPaisa: 99999 } as never;
    const saved = await callApi(staff.token, "PUT", `/products/${product.id}`, { body: update });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const owner = await callApi(business.ownerToken, "GET", `/products/${product.id}`);
    expect(owner.body.name).toBe("Renamed");
    expect(owner.body.variants[0].costPaisa).toBe(320);

    const created = await callApi(staff.token, "POST", "/products", { body: { ...productBody(ids, {}, "COSTLESS"), name: "Costless" } });
    expect(created.status).toBe(201);
    expect((await callApi(business.ownerToken, "GET", `/products/${created.body.id}`)).body.variants[0].costPaisa).toBe(0);
  });

  it("updates variants and units, archives dropped variants, and locks the base unit once stock has moved", async () => {
    const business = await createTestBusiness();
    const ids = await lookups(business);
    const product = await createProduct(business, productBody(ids));
    const [variant] = product.variants;

    const twoVariants = productBody(ids);
    twoVariants.variants = [
      { ...twoVariants.variants[0], id: variant.id, units: [twoVariants.variants[0].units[0], { unitId: ids.pack, factorToBase: "10", barcode: null, salePricePaisa: 4800 } as never] } as never,
      { sku: "BAL-12-BLU", variantName: "Blue", costPaisa: 320, reorderLevel: "0", units: [{ unitId: ids.piece, factorToBase: "1", barcode: null, salePricePaisa: 500 }] } as never,
    ];
    const updated = await callApi(business.ownerToken, "PUT", `/products/${product.id}`, { body: twoVariants });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.variants.map((row: { sku: string }) => row.sku)).toEqual(["BAL-12-BLU", "BAL-12-RED"]);
    const red = updated.body.variants.find((row: { sku: string }) => row.sku === "BAL-12-RED");
    expect(red.units.map((unit: { unitId: string }) => unit.unitId)).toEqual([ids.piece, ids.pack]);
    expect((await callApi(business.ownerToken, "GET", "/products/lookup?barcode=BAL-12-RED-CTN")).status).toBe(404);

    const onlyRed = productBody(ids);
    onlyRed.variants = [{ ...twoVariants.variants[0] }];
    const dropped = await callApi(business.ownerToken, "PUT", `/products/${product.id}`, { body: onlyRed });
    expect(dropped.body.variants.find((row: { sku: string }) => row.sku === "BAL-12-BLU").active).toBe(false);

    const foreignVariant = productBody(ids);
    foreignVariant.variants[0] = { ...foreignVariant.variants[0], id: crypto.randomUUID() } as never;
    expect((await callApi(business.ownerToken, "PUT", `/products/${product.id}`, { body: foreignVariant })).body.error.code).toBe("INVALID_VARIANT");

    const location = (await callApi<Array<{ id: string }>>(business.ownerToken, "GET", "/locations")).body[0].id;
    const { sql } = await import("./helpers");
    const client = sql();
    try {
      await client`
        INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, doc_type, doc_id)
        VALUES (${business.businessId}, ${variant.id}, ${location}, 5, 'test', ${crypto.randomUUID()})
      `;
    } finally {
      await client.end();
    }
    const newBase = productBody(ids, { baseUnitId: ids.pack });
    newBase.variants[0].units = [{ unitId: ids.pack, factorToBase: "1", barcode: null, salePricePaisa: 4800 } as never];
    newBase.variants[0] = { ...newBase.variants[0], id: variant.id } as never;
    const locked = await callApi(business.ownerToken, "PUT", `/products/${product.id}`, { body: newBase });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("BASE_UNIT_LOCKED");
  });

  it("archives products and hides them from the default list", async () => {
    const business = await createTestBusiness();
    const product = await createProduct(business, productBody(await lookups(business)));
    expect((await callApi(business.ownerToken, "DELETE", `/products/${product.id}`)).status).toBe(200);
    expect((await callApi(business.ownerToken, "GET", "/products")).body.total).toBe(0);
    expect((await callApi(business.ownerToken, "GET", "/products?active=false")).body.total).toBe(1);
    expect((await callApi(business.ownerToken, "GET", "/products?active=all")).body.total).toBe(1);
    const audit = await callApi(business.ownerToken, "GET", "/audit-log?pageSize=100");
    expect(audit.body.data.map((entry: { entity: string; action: string }) => `${entry.entity}:${entry.action}`)).toEqual(expect.arrayContaining(["product:create", "product:archive"]));
  });

  it("searches by name, SKU and barcode, treats % literally, and pages", async () => {
    const business = await createTestBusiness();
    const ids = await lookups(business);
    for (const [index, name] of ["Red Balloon", "Blue Balloon", "100% Cotton Rope"].entries()) {
      await createProduct(business, productBody(ids, { name }, `SKU-${index}`));
    }
    const search = async (q: string) => (await callApi(business.ownerToken, "GET", `/products?q=${encodeURIComponent(q)}`)).body.data.map((row: { name: string }) => row.name);
    expect(await search("balloon")).toEqual(["Blue Balloon", "Red Balloon"]);
    expect(await search("SKU-2")).toEqual(["100% Cotton Rope"]);
    expect(await search("SKU-1-CTN")).toEqual(["Blue Balloon"]);
    expect(await search("100%")).toEqual(["100% Cotton Rope"]);
    expect(await search("%")).toEqual(["100% Cotton Rope"]);
    expect(await search("zzz")).toEqual([]);
    const page = await callApi(business.ownerToken, "GET", "/products?pageSize=2&page=2");
    expect(page.body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page.body.data).toHaveLength(1);
  });

  it("manages categories, brands, tax categories and units with duplicate and loop protection", async () => {
    const business = await createTestBusiness();
    const root = await callApi(business.ownerToken, "POST", "/categories", { body: { name: "Balloons" } });
    const child = await callApi(business.ownerToken, "POST", "/categories", { body: { name: "Latex", parentId: root.body.id } });
    expect([root.status, child.status]).toEqual([201, 201]);
    expect((await callApi(business.ownerToken, "POST", "/categories", { body: { name: "balloons" } })).body.error.code).toBe("NAME_EXISTS");
    expect((await callApi(business.ownerToken, "POST", "/categories", { body: { name: "Latex", parentId: root.body.id } })).status).toBe(409);
    expect((await callApi(business.ownerToken, "POST", "/categories", { body: { name: "Latex" } })).status).toBe(201);
    expect((await callApi(business.ownerToken, "PUT", `/categories/${root.body.id}`, { body: { parentId: child.body.id } })).body.error.code).toBe("INVALID_PARENT");
    expect((await callApi(business.ownerToken, "PUT", `/categories/${root.body.id}`, { body: { parentId: root.body.id } })).body.error.code).toBe("INVALID_PARENT");
    expect((await callApi(business.ownerToken, "POST", "/categories", { body: { name: "Orphan", parentId: crypto.randomUUID() } })).body.error.code).toBe("INVALID_PARENT");

    expect((await callApi(business.ownerToken, "POST", "/brands", { body: { name: "Party Co" } })).status).toBe(201);
    expect((await callApi(business.ownerToken, "POST", "/brands", { body: { name: "PARTY CO" } })).status).toBe(409);

    const taxes = await callApi<Array<{ id: string; kind: string; rateBps: number }>>(business.ownerToken, "GET", "/tax-categories");
    const standard = taxes.body.find((tax) => tax.kind === "standard")!;
    const raised = await callApi(business.ownerToken, "PUT", `/tax-categories/${standard.id}`, { body: { rateBps: 1900 } });
    expect(raised.body.rateBps).toBe(1900);
    expect((await callApi(business.ownerToken, "PUT", `/tax-categories/${standard.id}`, { body: { rateBps: 10001 } })).status).toBe(400);

    expect((await callApi(business.ownerToken, "POST", "/units", { body: { name: "Gross", shortName: "gr" } })).status).toBe(201);
    expect((await callApi(business.ownerToken, "POST", "/units", { body: { name: "gross", shortName: "gr" } })).status).toBe(409);
  });

  it("stores price lists with quantity breaks and rejects units a product is not sold in", async () => {
    const business = await createTestBusiness();
    const ids = await lookups(business);
    const product = await createProduct(business, productBody(ids));
    const variantId = product.variants[0].id;
    const body = {
      name: "Wholesale",
      items: [
        { variantId, unitId: ids.carton, minQuantity: "1", pricePaisa: 450000 },
        { variantId, unitId: ids.carton, minQuantity: "10", pricePaisa: 420000 },
      ],
    };
    const created = await callApi(business.ownerToken, "POST", "/price-lists", { body });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const loaded = await callApi(business.ownerToken, "GET", `/price-lists/${created.body.id}`);
    expect(loaded.body.items.map((item: { minQuantity: string; pricePaisa: number }) => [item.minQuantity, item.pricePaisa])).toEqual([["1", 450000], ["10", 420000]]);
    expect(loaded.body.items[0]).toMatchObject({ sku: "BAL-12-RED", productName: "Latex Balloon 12 inch", variantId, unitId: ids.carton });
    expect(loaded.body.items[0].unitIds.sort()).toEqual([ids.carton, ids.piece].sort());

    expect((await callApi(business.ownerToken, "POST", "/price-lists", { body: { ...body, name: "wholesale" } })).status).toBe(409);
    expect((await callApi(business.ownerToken, "POST", "/price-lists", { body: { name: "Bad", items: [{ variantId, unitId: ids.pack, minQuantity: "1", pricePaisa: 1 }] } })).body.error.code).toBe("INVALID_PRICE_ITEM");
    expect((await callApi(business.ownerToken, "POST", "/price-lists", { body: { name: "Dup", items: [body.items[0], body.items[0]] } })).status).toBe(400);

    const replaced = await callApi(business.ownerToken, "PUT", `/price-lists/${created.body.id}`, { body: { name: "Wholesale", items: [body.items[1]] } });
    expect(replaced.body.items).toHaveLength(1);
  });

  describe("CSV import", () => {
    const header = "sku,name,variant_name,category,brand,tax_category,hs_code,base_unit,sale_price,cost,barcode,reorder_level,alt_unit,alt_factor,alt_barcode,alt_price";

    it("previews errors per row, blocks the import until they are fixed, then imports", async () => {
      const business = await createTestBusiness();
      const bad = csv(
        header,
        "B-1,Balloon,Red,Balloons > Latex,Party Co,Standard rate 18%,9503.0090,Piece,5,3.2,9001,500,Carton,1000,9002,4500",
        "B-2,Balloon,Blue,Balloons > Latex,Party Co,Standard rate 18%,9503.0090,Piece,5.555,3.2,,,,,,",
        "B-3,Pump,,,,Luxury tax,,Piece,100,,,,,,,",
      );
      const preview = await callApi(business.ownerToken, "POST", "/products/import/preview", { body: { csv: bad } });
      expect(preview.status).toBe(200);
      expect(preview.body.canImport).toBe(false);
      expect(preview.body.issues.map((issue: { row: number; field: string }) => `${issue.row}:${issue.field}`)).toEqual(["3:sale_price", "4:tax_category"]);
      expect(preview.body.summary.products).toBe(2);

      const blocked = await importCsv(business, bad);
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.code).toBe("IMPORT_HAS_ERRORS");
      expect(blocked.body.error.details).toHaveLength(2);
      expect((await callApi(business.ownerToken, "GET", "/products")).body.total).toBe(0);
      expect((await callApi(business.ownerToken, "GET", "/categories")).body).toEqual([]);

      const fixed = bad.replace("5.555", "5.55").replace("Luxury tax", "Exempt");
      const ok = await callApi(business.ownerToken, "POST", "/products/import/preview", { body: { csv: fixed } });
      expect(ok.body).toMatchObject({ canImport: true, issues: [], summary: { products: 2, variantsToCreate: 3, variantsToUpdate: 0, newCategories: ["Balloons", "Balloons > Latex"], newBrands: ["Party Co"] } });

      const done = await importCsv(business, fixed);
      expect(done.status, JSON.stringify(done.body)).toBe(201);
      expect(done.body).toMatchObject({ products: 2, variantsCreated: 3, categoriesCreated: 2, brandsCreated: 1 });

      const balloon = (await callApi(business.ownerToken, "GET", "/products?q=balloon")).body.data[0];
      expect(balloon.variants.map((variant: { sku: string }) => variant.sku)).toEqual(["B-1", "B-2"]);
      expect(balloon.variants[0]).toMatchObject({ costPaisa: 320 });
      expect(balloon.variants[0].units.map((unit: { factorToBase: string; salePricePaisa: number }) => [unit.factorToBase, unit.salePricePaisa])).toEqual([["1", 500], ["1000", 450000]]);
      expect((await callApi(business.ownerToken, "GET", "/products/lookup?barcode=9002")).body.factorToBase).toBe("1000");
    });

    it("replays a retried commit instead of importing twice, and rejects missing or reused keys", async () => {
      const business = await createTestBusiness();
      const file = csv("sku,name,sale_price", "K-1,Kettle,10", "K-2,Cup,2");
      const key = importKey();
      const first = await importCsv(business, file, key);
      const retry = await importCsv(business, file, key);
      expect([first.status, retry.status]).toEqual([201, 201]);
      expect(retry.replayed).toBe(true);
      expect(retry.body).toEqual(first.body);
      expect((await callApi(business.ownerToken, "GET", "/products")).body.total).toBe(2);

      const reused = await importCsv(business, csv("sku,name", "K-9,Other"), key);
      expect(reused.status).toBe(422);
      expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect((await importCsv(business, file, "short")).body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

      // A failed attempt does not burn the key.
      const failedKey = importKey();
      expect((await importCsv(business, csv("sku,name", "K-1,Duplicate"), failedKey)).status).toBe(201);
      const invalid = await importCsv(business, csv("sku,name,bogus", "Z-1,Zed,1"), failedKey);
      expect(invalid.status).toBe(422);
      expect((await importCsv(business, csv("sku,name,bogus", "Z-1,Zed,1"), failedKey)).status).toBe(422);
    });

    it("updates existing SKUs, leaves blank cells unchanged and refuses to change the base unit", async () => {
      const business = await createTestBusiness();
      const ids = await lookups(business);
      const product = await createProduct(business, productBody(ids));
      const variantId = product.variants[0].id;

      const update = await importCsv(business, csv("sku,name,sale_price,cost,reorder_level", "BAL-12-RED,Latex Balloon 12 inch,6.50,,"));
      expect(update.status, JSON.stringify(update.body)).toBe(201);
      expect(update.body).toMatchObject({ variantsCreated: 0, variantsUpdated: 1 });
      const after = (await callApi(business.ownerToken, "GET", `/products/${product.id}`)).body;
      expect(after.variants[0]).toMatchObject({ id: variantId, costPaisa: 320, reorderLevel: "500" });
      expect(after.variants[0].units.map((unit: { salePricePaisa: number; barcode: string }) => [unit.salePricePaisa, unit.barcode])).toEqual([[650, "BAL-12-RED-PC"], [450000, "BAL-12-RED-CTN"]]);

      // A new SKU joins an existing product only when an existing SKU of that product is in the same file.
      const addVariant = await importCsv(business, csv("sku,name,variant_name", "BAL-12-RED,Latex Balloon 12 inch,", "BAL-12-GRN,Latex Balloon 12 inch,Green"));
      expect(addVariant.body).toMatchObject({ variantsCreated: 1, variantsUpdated: 1 });
      expect((await callApi(business.ownerToken, "GET", `/products/${product.id}`)).body.variants).toHaveLength(2);
      const standalone = await importCsv(business, csv("sku,name", "BAL-12-YLW,Latex Balloon 12 inch"));
      expect(standalone.body).toMatchObject({ variantsCreated: 1 });
      expect((await callApi(business.ownerToken, "GET", "/products?q=BAL-12-YLW")).body.data[0].id).not.toBe(product.id);

      const baseChange = await importCsv(business, csv("sku,name,base_unit", "BAL-12-RED,Latex Balloon 12 inch,Pack"));
      expect(baseChange.status).toBe(422);
      const stolen = await importCsv(business, csv("sku,name,barcode", "NEW-1,Thief,BAL-12-RED-PC"));
      expect(stolen.body.error.details[0].message).toContain("already belongs to another product");
    });

    it("stops users without cost access from importing costs", async () => {
      const business = await createTestBusiness();
      const role = await callApi(business.ownerToken, "POST", "/roles", { body: { name: "Importer", permissionKeys: ["catalog.view", "catalog.manage", "products.import"] } });
      business.roleIds.Importer = role.body.id;
      const staff = await inviteTestStaff(business, "Importer");
      const denied = await importCsv(business, csv("sku,name,cost", "C-1,Costed,50"), importKey(), staff.token);
      expect(denied.status).toBe(422);
      expect(denied.body.error.details[0]).toMatchObject({ field: "cost" });
      expect((await importCsv(business, csv("sku,name,sale_price", "C-1,Costed,50"), importKey(), staff.token)).status).toBe(201);
    });

    it("imports 500 products with barcodes in a few seconds", async () => {
      const business = await createTestBusiness();
      const rows = Array.from({ length: 500 }, (_, index) => `SKU-${index},Product ${index},${10 + index},${5 + index},89640${String(index).padStart(8, "0")}`);
      const started = Date.now();
      const done = await importCsv(business, csv("sku,name,sale_price,cost,barcode", ...rows));
      expect(done.status, JSON.stringify(done.body).slice(0, 300)).toBe(201);
      expect(done.body.variantsCreated).toBe(500);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect((await callApi(business.ownerToken, "GET", "/products")).body.total).toBe(500);
      expect((await callApi(business.ownerToken, "GET", "/products/lookup?barcode=8964000000499")).status).toBe(200);
    });

    it("exports what it can re-import without changing anything, and hides costs from users who cannot see them", async () => {
      const business = await createTestBusiness();
      const ids = await lookups(business);
      await importCsv(business, csv(header, "E-1,Export Me,Red,Toys > Balloons,Party Co,Standard rate 18%,9503.0090,Piece,5,3.2,7001,500,Carton,1000,7002,4500"));
      await createProduct(business, productBody(ids, { name: "=1+1 Formula" }, "E-2"));

      const { app } = await import("../../server/app");
      const exportAs = async (token: string) => {
        const response = await app.fetch(new Request("http://localhost/api/v1/products/export", { headers: { Authorization: `Bearer ${token}` } }));
        expect(response.headers.get("Content-Disposition")).toMatch(/products-\d{4}-\d{2}-\d{2}\.csv/);
        return response.text();
      };
      const exported = await exportAs(business.ownerToken);
      expect(exported).toContain("E-1,Export Me,Red,Toys > Balloons,Party Co,Standard rate 18%,9503.0090,Piece,5.00,3.20,7001,500,0,Carton,1000,7002,4500.00");
      expect(exported).toContain("E-2,'=1+1 Formula");

      const again = await importCsv(business, exported);
      expect(again.status, JSON.stringify(again.body)).toBe(201);
      expect(again.body).toMatchObject({ variantsCreated: 0, variantsUpdated: 2 });
      expect((await callApi(business.ownerToken, "GET", "/products/lookup?barcode=7002")).body.factorToBase).toBe("1000");

      const exporter = await callApi(business.ownerToken, "POST", "/roles", { body: { name: "Exporter", permissionKeys: ["catalog.view", "products.export"] } });
      business.roleIds.Exporter = exporter.body.id;
      const staff = await inviteTestStaff(business, "Exporter");
      const redacted = await exportAs(staff.token);
      expect(redacted).toContain("E-1,Export Me,Red,Toys > Balloons,Party Co,Standard rate 18%,9503.0090,Piece,5.00,,7001,500,0,Carton,1000,7002,4500.00");
      expect(redacted).not.toContain("3.20");
    });
  });
});
