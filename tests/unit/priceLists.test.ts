import { describe, expect, it } from "vitest";
import { effectivePriceListId, tierPrice, type PriceListItem } from "../../shared/priceLists";

const items: PriceListItem[] = [
  { variantId: "v1", unitId: "pc", minQuantityMilli: 1000, pricePaisa: 450 },
  { variantId: "v1", unitId: "pc", minQuantityMilli: 100000, pricePaisa: 400 },
  { variantId: "v1", unitId: "ctn", minQuantityMilli: 1000, pricePaisa: 80000 },
  { variantId: "v1", unitId: "ctn", minQuantityMilli: 10000, pricePaisa: 76000 },
  { variantId: "v2", unitId: "pc", minQuantityMilli: 500, pricePaisa: 99 },
];

describe("tierPrice", () => {
  it("takes the item with the largest minimum quantity the line reaches", () => {
    expect(tierPrice(items, "v1", "pc", 1000)).toBe(450);
    expect(tierPrice(items, "v1", "pc", 99999)).toBe(450);
    expect(tierPrice(items, "v1", "pc", 100000)).toBe(400);
    expect(tierPrice(items, "v1", "ctn", 10000)).toBe(76000);
    expect(tierPrice(items, "v1", "ctn", 9999)).toBe(80000);
  });

  it("is null below the first break, for another unit or SKU, or for an empty list", () => {
    expect(tierPrice(items, "v1", "pc", 999)).toBeNull();
    expect(tierPrice(items, "v1", "pack", 5000)).toBeNull();
    expect(tierPrice(items, "v3", "pc", 5000)).toBeNull();
    expect(tierPrice([], "v1", "pc", 5000)).toBeNull();
  });

  it("does not depend on the order of the items", () => {
    expect(tierPrice([...items].reverse(), "v1", "pc", 100000)).toBe(400);
  });

  it("allows a fractional break such as half a kilo", () => {
    expect(tierPrice(items, "v2", "pc", 500)).toBe(99);
    expect(tierPrice(items, "v2", "pc", 499)).toBeNull();
  });
});

describe("effectivePriceListId", () => {
  it("is the customer's own list, else the group's, else none", () => {
    expect(effectivePriceListId({ priceListId: "own" }, { priceListId: "group" })).toBe("own");
    expect(effectivePriceListId({ priceListId: null }, { priceListId: "group" })).toBe("group");
    expect(effectivePriceListId({ priceListId: null }, { priceListId: null })).toBeNull();
    expect(effectivePriceListId({ priceListId: null }, undefined)).toBeNull();
  });
});
