import { beforeEach, describe, expect, it } from "vitest";
import type { Product } from "../../src/api/productsApi";
import { addEntry, emptyCart, parseStoredCart, removeLine, toSaleRequest, totalsOf, updateLine } from "../../src/pos/cart";
import { CatalogueIndex } from "../../src/pos/catalogueIndex";
import { useCartStore } from "../../src/pos/cartStore";

const PIECE = "00000000-0000-4000-8000-000000000001";
const PACK = "00000000-0000-4000-8000-000000000002";
const TAX = "00000000-0000-4000-8000-0000000000aa";
const V1 = "00000000-0000-4000-8000-0000000000b1";
const V2 = "00000000-0000-4000-8000-0000000000b2";
const METHOD = "00000000-0000-4000-8000-0000000000c1";

const item = (variant: string, sku: string, tax: string | null): Product => ({
  id: `p-${sku}`, name: `Item ${sku}`, description: "", categoryId: null, brandId: null, taxCategoryId: tax, hsCode: null, imageUrl: null,
  productType: "stocked", baseUnitId: PIECE, active: true,
  variants: [{
    id: variant, sku, variantName: "", attributes: {}, reorderLevel: "0", reorderQuantity: "0", active: true,
    units: [
      { id: `${sku}-1`, unitId: PIECE, factorToBase: "1", isBase: true, barcode: `${sku}-PC`, salePricePaisa: 1000, fbrUom: null },
      { id: `${sku}-2`, unitId: PACK, factorToBase: "10", isBase: false, barcode: `${sku}-PK`, salePricePaisa: 9000, fbrUom: null },
    ],
  }],
});

const catalogue = new CatalogueIndex([item(V1, "A", TAX), item(V2, "B", null)], {
  units: [{ id: PIECE, name: "Piece" }, { id: PACK, name: "Pack" }],
  taxCategories: [{ id: TAX, rateBps: 1800 }],
});

describe("cart", () => {
  it("scanning the same item again raises the quantity; a different unit is its own row", () => {
    let cart = addEntry(emptyCart, { variantId: V1, unitId: PIECE });
    cart = addEntry(cart, { variantId: V1, unitId: PIECE });
    cart = addEntry(cart, { variantId: V1, unitId: PACK }, 2000);
    expect(cart.lines.map((line) => [line.unitId, line.quantityMilli])).toEqual([[PIECE, 2000], [PACK, 2000]]);
  });

  it("a row with its own discount or price is not merged into", () => {
    let cart = addEntry(emptyCart, { variantId: V1, unitId: PIECE });
    cart = updateLine(cart, cart.lines[0].key, { discount: { type: "percent", bps: 1000 } });
    cart = addEntry(cart, { variantId: V1, unitId: PIECE });
    expect(cart.lines).toHaveLength(2);
    expect(removeLine(cart, cart.lines[0].key).lines).toHaveLength(1);
  });

  it("prices with the shared engine: inclusive tax is inside the price, exclusive is added", () => {
    const cart = addEntry(addEntry(emptyCart, { variantId: V1, unitId: PIECE }, 2000), { variantId: V2, unitId: PIECE });
    const inclusive = totalsOf(cart, catalogue, "inclusive", 0)!;
    expect(inclusive.priced.totalPaisa).toBe(3000); // 2 x 10.00 + 10.00
    expect(inclusive.priced.taxPaisa).toBe(305); // 20.00 inclusive of 18% -> 3.05
    const exclusive = totalsOf(cart, catalogue, "exclusive", 0)!;
    expect(exclusive.priced.taxPaisa).toBe(360);
    expect(exclusive.priced.totalPaisa).toBe(3360);
  });

  it("applies line and bill discounts, a price override and cash rounding", () => {
    let cart = addEntry(emptyCart, { variantId: V2, unitId: PIECE }, 3000);
    cart = updateLine(cart, cart.lines[0].key, { discount: { type: "fixed", paisa: 500 } });
    cart = { ...cart, invoiceDiscount: { type: "percent", bps: 500 } };
    const totals = totalsOf(cart, catalogue, "inclusive", 0)!;
    expect(totals.priced).toMatchObject({ grossPaisa: 3000, lineDiscountPaisa: 500, invoiceDiscountPaisa: 125, totalPaisa: 2375 });
    expect(totalsOf(cart, catalogue, "inclusive", 500)!.priced).toMatchObject({ totalPaisa: 2500, roundingPaisa: 125 });
    const overridden = updateLine(emptyCart, addEntry(emptyCart, { variantId: V2, unitId: PIECE }).lines[0].key, {});
    expect(totalsOf(overridden, catalogue, "inclusive", 0)).toBeNull();
  });

  it("reports lines whose product left the catalogue instead of pricing them", () => {
    const cart = addEntry(addEntry(emptyCart, { variantId: V2, unitId: PIECE }), { variantId: "gone", unitId: PIECE });
    const totals = totalsOf(cart, catalogue, "inclusive", 0)!;
    expect(totals.lines).toHaveLength(1);
    expect(totals.missing.map((line) => line.variantId)).toEqual(["gone"]);
    expect(totalsOf(addEntry(emptyCart, { variantId: "gone", unitId: PIECE }), catalogue, "inclusive", 0)).toBeNull();
  });

  it("builds the sale request with exact quantities, only the overrides that exist, and the payments", () => {
    let cart = addEntry(emptyCart, { variantId: V1, unitId: PACK }, 2500);
    cart = updateLine(cart, cart.lines[0].key, { priceOverridePaisa: 8000 });
    cart = { ...cart, invoiceDiscount: { type: "percent", bps: 500 } };
    const request = toSaleRequest(cart, "shift-1", [{ methodId: METHOD, amountPaisa: 5000 }], { expectedTotalPaisa: 19000 });
    expect(request).toEqual({
      shiftId: "shift-1",
      lines: [{ variantId: V1, unitId: PACK, quantity: "2.5", unitPricePaisa: 8000 }],
      invoiceDiscount: { type: "percent", bps: 500 },
      payments: [{ methodId: METHOD, amountPaisa: 5000, reference: "" }],
      expectedTotalPaisa: 19000,
    });
  });

  it("accepts a stored cart of the right shape and refuses anything else", () => {
    const cart = addEntry(emptyCart, { variantId: V1, unitId: PIECE });
    expect(parseStoredCart(JSON.parse(JSON.stringify(cart)))).toEqual(cart);
    expect(parseStoredCart({ lines: [{ key: "k", variantId: "not-a-uuid", unitId: PIECE, quantityMilli: 1000, priceOverridePaisa: null, discount: null }], invoiceDiscount: null })).toBeNull();
    expect(parseStoredCart({ lines: [], invoiceDiscount: { type: "percent", bps: 99999 } })).toBeNull();
    expect(parseStoredCart("junk")).toBeNull();
    expect(parseStoredCart(null)).toBeNull();
  });
});

describe("cart store", () => {
  beforeEach(() => useCartStore.getState().clear());

  it("keeps one checkout key while the cart is unchanged, so a second press of Pay repeats the same sale", () => {
    const store = useCartStore.getState();
    store.add({ variantId: V1, unitId: PIECE });
    const first = useCartStore.getState().beginCheckout();
    expect(useCartStore.getState().beginCheckout()).toBe(first);
    useCartStore.getState().add({ variantId: V2, unitId: PIECE });
    expect(useCartStore.getState().checkoutKey).toBeNull();
    expect(useCartStore.getState().beginCheckout()).not.toBe(first);
  });

  it("is saved in the browser and an emptied cart forgets its key", () => {
    useCartStore.getState().add({ variantId: V1, unitId: PIECE }, 3000);
    const saved = JSON.parse(localStorage.getItem("pos.cart")!) as { cart: { lines: Array<{ quantityMilli: number }> } };
    expect(saved.cart.lines[0].quantityMilli).toBe(3000);
    useCartStore.getState().beginCheckout();
    useCartStore.getState().clear();
    expect(useCartStore.getState()).toMatchObject({ lines: [], checkoutKey: null, invoiceDiscount: null });
  });
});
