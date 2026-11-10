import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { ProductChanges } from "../../src/api/posApi";
import type { Product } from "../../src/api/productsApi";
import { PosCache } from "../../src/pos/catalogueCache";
import { CatalogueIndex } from "../../src/pos/catalogueIndex";
import { syncCatalogue, whatChanged } from "../../src/pos/catalogueSync";

const PIECE = "00000000-0000-4000-8000-000000000001";
const CARTON = "00000000-0000-4000-8000-000000000002";
const TAX18 = "00000000-0000-4000-8000-0000000000aa";
const reference = {
  units: [{ id: PIECE, name: "Piece" }, { id: CARTON, name: "Carton" }],
  taxCategories: [{ id: TAX18, rateBps: 1800 }],
};

function product(id: string, name: string, sku: string, overrides: Partial<Product> = {}): Product {
  return {
    id, name, description: "", categoryId: null, brandId: null, taxCategoryId: null, hsCode: null, imageUrl: null, productType: "stocked",
    baseUnitId: PIECE, active: true,
    variants: [{
      id: `v-${id}`, sku, variantName: "", attributes: {}, reorderLevel: "0", reorderQuantity: "0", active: true,
      units: [
        { id: `${id}-pc`, unitId: PIECE, factorToBase: "1", isBase: true, barcode: `${sku}-PC`, salePricePaisa: 500, fbrUom: null },
        { id: `${id}-ctn`, unitId: CARTON, factorToBase: "200", isBase: false, barcode: `${sku}-CTN`, salePricePaisa: 90000, fbrUom: null },
      ],
    }],
    ...overrides,
  };
}

describe("CatalogueIndex", () => {
  const index = new CatalogueIndex([
    product("p1", "Red Balloon", "BAL-RED", { taxCategoryId: TAX18 }),
    product("p2", "Blue Balloon", "BAL-BLUE"),
    product("p3", "Ribbon Roll", "RIB-1"),
    product("p4", "Archived thing", "OLD-1", { active: false }),
  ], reference);

  it("has one entry per SKU and unit, active products only, with the tax rate resolved", () => {
    expect(index.size).toBe(6);
    expect(index.findByBarcode("BAL-RED-PC")).toMatchObject({ productName: "Red Balloon", unitName: "Piece", pricePaisa: 500, taxRateBps: 1800, factorToBaseMilli: 1000 });
    expect(index.findByBarcode("BAL-RED-CTN")).toMatchObject({ unitName: "Carton", pricePaisa: 90000, factorToBaseMilli: 200000 });
    expect(index.findByBarcode("BAL-BLUE-PC")?.taxRateBps).toBe(0);
    expect(index.findByBarcode("OLD-1-PC")).toBeUndefined();
    expect(index.findByBarcode("nope")).toBeUndefined();
  });

  it("looks up a SKU in a unit and lists a SKU's units smallest first", () => {
    expect(index.get("v-p1", CARTON)?.barcode).toBe("BAL-RED-CTN");
    expect(index.unitsOf("v-p1").map((entry) => entry.unitName)).toEqual(["Piece", "Carton"]);
  });

  it("searches: a typed barcode or SKU is exact, otherwise every word must match and prefixes come first", () => {
    expect(index.search("BAL-RED-PC").map((entry) => entry.barcode)).toEqual(["BAL-RED-PC"]);
    expect(index.search("bal-blue").map((entry) => entry.sku)).toEqual(["BAL-BLUE", "BAL-BLUE"]);
    expect([...new Set(index.search("balloon").map((entry) => entry.productName))]).toEqual(["Blue Balloon", "Red Balloon"]);
    expect([...new Set(index.search("red ball").map((entry) => entry.productName))]).toEqual(["Red Balloon"]);
    expect([...new Set(index.search("ribbon").map((entry) => entry.productName))]).toEqual(["Ribbon Roll"]);
    expect(index.search("   ")).toEqual([]);
    expect(index.search("zzz")).toEqual([]);
    expect(index.search("balloon", 2)).toHaveLength(2);
  });
});

describe("catalogue cache and sync", () => {
  let scopeCounter = 0;
  const openCache = () => PosCache.open(`test-cache-${scopeCounter++}`);

  it("stores products and the version together, drops archived ones, and survives reopening", async () => {
    const scope = `test-cache-reopen`;
    const cache = await PosCache.open(scope);
    expect(await cache.getVersion()).toBe(0);
    await cache.applyChanges([product("p1", "A", "A-1"), product("p2", "B", "B-1")], 5);
    await cache.applyChanges([product("p2", "B", "B-1", { active: false }), product("p3", "C", "C-1")], 9);
    cache.close();

    const again = await PosCache.open(scope);
    expect(await again.getVersion()).toBe(9);
    expect((await again.getProducts()).map((row) => row.id).sort()).toEqual(["p1", "p3"]);
    await again.clear();
    expect(await again.getVersion()).toBe(0);
    expect(await again.getProducts()).toEqual([]);
    again.close();
    await PosCache.destroy(scope);
  });

  it("loads in pages from version 0, resumes from the stored version, and applies a later delta", async () => {
    const cache = await openCache();
    const asked: number[] = [];
    const pages: ProductChanges[] = [
      { version: 4, hasMore: true, products: [product("p1", "A", "A-1")] },
      { version: 7, hasMore: false, products: [product("p2", "B", "B-1")] },
    ];
    const first = await syncCatalogue(cache, async (since) => { asked.push(since); return pages.shift()!; });
    expect(first).toEqual({ version: 7, changed: 2 });
    expect(asked).toEqual([0, 4]);

    const nothing = await syncCatalogue(cache, async (since) => { asked.push(since); return { version: 7, hasMore: false, products: [] }; });
    expect(nothing).toEqual({ version: 7, changed: 0 });
    expect(asked.at(-1)).toBe(7);

    await syncCatalogue(cache, async () => ({ version: 8, hasMore: false, products: [product("p1", "A renamed", "A-1"), product("p2", "B", "B-1", { active: false })] }));
    const held = await cache.getProducts();
    expect(held.map((row) => row.name)).toEqual(["A renamed"]);
    expect(await cache.getVersion()).toBe(8);
    cache.close();
  });

  it("keeps the pages it already saved when a later page fails, and carries on from there", async () => {
    const cache = await openCache();
    await expect(syncCatalogue(cache, async (since) => {
      if (since === 0) return { version: 3, hasMore: true, products: [product("p1", "A", "A-1")] };
      throw new Error("network down");
    })).rejects.toThrow("network down");
    expect(await cache.getVersion()).toBe(3);
    const asked: number[] = [];
    await syncCatalogue(cache, async (since) => { asked.push(since); return { version: 6, hasMore: false, products: [product("p2", "B", "B-1")] }; });
    expect(asked).toEqual([3]);
    expect((await cache.getProducts()).map((row) => row.id).sort()).toEqual(["p1", "p2"]);
    cache.close();
  });

  it("names the datasets whose counters moved", () => {
    const held = { catalogue: 5, reference: 2, settings: 1, access: 3, customers: 7 };
    expect(whatChanged(held, held)).toEqual([]);
    expect(whatChanged(held, { ...held, catalogue: 6, access: 4 })).toEqual(["catalogue", "access"]);
  });
});
