import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { CustomerChanges, TillCustomer } from "../../src/api/customersApi";
import type { Product } from "../../src/api/productsApi";
import { addEntry, emptyCart, toSaleRequest, totalsOf, unitPriceOf, updateLine } from "../../src/pos/cart";
import { PosCache } from "../../src/pos/catalogueCache";
import { CatalogueIndex } from "../../src/pos/catalogueIndex";
import { syncCustomers } from "../../src/pos/catalogueSync";
import { CustomerIndex } from "../../src/pos/customerIndex";

const customer = (id: string, name: string, extra: Partial<TillCustomer> = {}): TillCustomer => ({
  id, name, businessName: "", phone: "", phone2: "", whatsapp: "", address: "", areaId: null, groupId: null, registered: false, ntn: null, strn: null,
  priceListId: null, creditLimitPaisa: 0, termsDays: 0, active: true, ...extra,
});

describe("CustomerIndex", () => {
  const index = new CustomerIndex([
    customer("1", "Ali Traders", { businessName: "Ali & Sons", phone: "0300-1234567" }),
    customer("2", "Bilal Store", { phone: "0321 5550000", whatsapp: "+92 333 7778888" }),
    customer("3", "Chaudhry Mart", { phone2: "021-3456789" }),
    customer("4", "Archived Co", { active: false, phone: "0300-9999999" }),
  ]);

  it("holds active customers only, by name", () => {
    expect(index.size).toBe(3);
    expect(index.get("2")?.name).toBe("Bilal Store");
    expect(index.get("4")).toBeUndefined();
  });

  it("finds by every typed word in the name or business name", () => {
    expect(index.search("ali").map((row) => row.id)).toEqual(["1"]);
    expect(index.search("sons ali").map((row) => row.id)).toEqual(["1"]);
    expect(index.search("store bil").map((row) => row.id)).toEqual(["2"]);
    expect(index.search("zzz")).toEqual([]);
    expect(index.search("  ")).toEqual([]);
  });

  it("finds by any part of any phone, ignoring spaces, dashes and the plus sign", () => {
    expect(index.search("5550000").map((row) => row.id)).toEqual(["2"]);
    expect(index.search("0300-123").map((row) => row.id)).toEqual(["1"]);
    expect(index.search("3337778888").map((row) => row.id)).toEqual(["2"]);
    expect(index.search("3456789").map((row) => row.id)).toEqual(["3"]);
    expect(index.search("9999999")).toEqual([]);
  });

  it("limits the number of answers", () => {
    const many = new CustomerIndex(Array.from({ length: 50 }, (_, i) => customer(String(i), `Shop ${i}`)));
    expect(many.search("shop", 5)).toHaveLength(5);
  });
});

describe("customer cache and sync", () => {
  it("stores customers with their own version, drops archived ones, and resumes", async () => {
    const cache = await PosCache.open("test-customers-1");
    expect(await cache.getCustomersVersion()).toBe(0);
    const asked: number[] = [];
    const pages: CustomerChanges[] = [
      { version: 3, hasMore: true, customers: [customer("1", "A"), customer("2", "B")] },
      { version: 5, hasMore: false, customers: [customer("3", "C")] },
    ];
    expect(await syncCustomers(cache, async (since) => { asked.push(since); return pages.shift()!; })).toEqual({ version: 5, changed: 3 });
    expect(asked).toEqual([0, 3]);
    await syncCustomers(cache, async () => ({ version: 6, hasMore: false, customers: [customer("2", "B", { active: false }), customer("1", "A renamed")] }));
    expect((await cache.getCustomers()).map((row) => row.name).sort()).toEqual(["A renamed", "C"]);
    expect(await cache.getCustomersVersion()).toBe(6);
    // Products and customers keep separate versions.
    expect(await cache.getVersion()).toBe(0);
    await cache.clear();
    expect(await cache.getCustomers()).toEqual([]);
    cache.close();
    await PosCache.destroy("test-customers-1");
  });

  it("upgrades a cache made before customers existed without losing its products", async () => {
    const scope = "test-customers-upgrade";
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(scope, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("products", { keyPath: "id" }).put({ id: "p1", active: true, name: "Old product", variants: [] });
        open.result.createObjectStore("meta").put(9, "catalogueVersion");
      };
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = () => reject(open.error);
    });
    const cache = await PosCache.open(scope);
    expect((await cache.getProducts()).map((row) => row.id)).toEqual(["p1"]);
    expect(await cache.getVersion()).toBe(9);
    expect(await cache.getCustomers()).toEqual([]);
    cache.close();
    await PosCache.destroy(scope);
  });
});

describe("cart with a customer and a price tier", () => {
  const PIECE = "00000000-0000-4000-8000-000000000001";
  const V1 = "00000000-0000-4000-8000-0000000000b1";
  const CUST = "00000000-0000-4000-8000-0000000000d1";
  const product: Product = {
    id: "p", name: "Item", description: "", categoryId: null, brandId: null, taxCategoryId: null, hsCode: null, imageUrl: null, productType: "stocked", baseUnitId: PIECE, active: true,
    variants: [{ id: V1, sku: "A", variantName: "", attributes: {}, reorderLevel: "0", reorderQuantity: "0", active: true, units: [{ id: "u", unitId: PIECE, factorToBase: "1", isBase: true, barcode: "A-PC", salePricePaisa: 500, fbrUom: null }] }],
  };
  const catalogue = new CatalogueIndex([product], { units: [{ id: PIECE, name: "Piece" }], taxCategories: [] });
  const tier = [
    { variantId: V1, unitId: PIECE, minQuantityMilli: 1000, pricePaisa: 450 },
    { variantId: V1, unitId: PIECE, minQuantityMilli: 100000, pricePaisa: 400 },
  ];

  it("prices a line at the typed price, else the tier for its quantity, else the shelf", () => {
    const entry = { pricePaisa: 500 };
    const line = { variantId: V1, unitId: PIECE, quantityMilli: 2000, priceOverridePaisa: null };
    expect(unitPriceOf(line, entry)).toBe(500);
    expect(unitPriceOf(line, entry, tier)).toBe(450);
    expect(unitPriceOf({ ...line, quantityMilli: 100000 }, entry, tier)).toBe(400);
    expect(unitPriceOf({ ...line, quantityMilli: 500 }, entry, tier)).toBe(500);
    expect(unitPriceOf({ ...line, priceOverridePaisa: 300 }, entry, tier)).toBe(300);
  });

  it("totals follow the tier as the quantity crosses a break", () => {
    let cart = addEntry(emptyCart, { variantId: V1, unitId: PIECE }, 2000);
    expect(totalsOf(cart, catalogue, "inclusive", 0, tier)!.priced.totalPaisa).toBe(900);
    expect(totalsOf(cart, catalogue, "inclusive", 0)!.priced.totalPaisa).toBe(1000);
    cart = updateLine(cart, cart.lines[0].key, { quantityMilli: 100000 });
    expect(totalsOf(cart, catalogue, "inclusive", 0, tier)!.priced.totalPaisa).toBe(40000);
  });

  it("sends the customer with the sale only when there is one", () => {
    const cart = addEntry(emptyCart, { variantId: V1, unitId: PIECE });
    expect(toSaleRequest(cart, "s", [{ methodId: "m", amountPaisa: 500 }])).not.toHaveProperty("customerId");
    expect(toSaleRequest({ ...cart, customerId: CUST }, "s", [{ methodId: "m", amountPaisa: 450 }]).customerId).toBe(CUST);
  });
});
