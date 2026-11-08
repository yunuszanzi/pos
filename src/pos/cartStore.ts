import { create } from "zustand";
import type { Discount } from "../../shared/pricing";
import { addEntry, emptyCart, parseStoredCart, removeLine, updateLine, type Cart, type CartLine } from "./cart";
import type { CatalogueEntry } from "./catalogueIndex";

const storageKey = "pos.cart";

function load(): { cart: Cart; checkoutKey: string | null } {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "null") as { cart?: unknown; checkoutKey?: unknown } | null;
    const cart = parseStoredCart(stored?.cart);
    if (cart) return { cart, checkoutKey: typeof stored?.checkoutKey === "string" ? stored.checkoutKey : null };
  } catch {
    // Storage unavailable or corrupt: start with an empty cart.
  }
  return { cart: emptyCart, checkoutKey: null };
}

type CartState = Cart & {
  /** The Idempotency-Key of the checkout in progress. It lives as long as the cart does, so pressing Pay twice, or again after a lost reply, can never post twice. */
  checkoutKey: string | null;
  add: (entry: Pick<CatalogueEntry, "variantId" | "unitId">, quantityMilli?: number) => void;
  update: (key: string, change: Partial<Omit<CartLine, "key" | "variantId">>) => void;
  remove: (key: string) => void;
  setInvoiceDiscount: (discount: Discount | null) => void;
  replace: (cart: Cart) => void;
  /** The key for this checkout, made on first use. */
  beginCheckout: () => string;
  clear: () => void;
};

export const useCartStore = create<CartState>((set, get) => {
  const initial = load();
  return {
    ...initial.cart,
    checkoutKey: initial.checkoutKey,
    // Any change to the cart is a different sale, so it gets a different key.
    add: (entry, quantityMilli) => set((state) => ({ ...addEntry(state, entry, quantityMilli), checkoutKey: null })),
    update: (key, change) => set((state) => ({ ...updateLine(state, key, change), checkoutKey: null })),
    remove: (key) => set((state) => ({ ...removeLine(state, key), checkoutKey: null })),
    setInvoiceDiscount: (invoiceDiscount) => set({ invoiceDiscount, checkoutKey: null }),
    replace: (cart) => set({ ...cart, checkoutKey: null }),
    beginCheckout: () => {
      const existing = get().checkoutKey;
      if (existing) return existing;
      const checkoutKey = `sale-${crypto.randomUUID()}`;
      set({ checkoutKey });
      return checkoutKey;
    },
    clear: () => set({ ...emptyCart, checkoutKey: null }),
  };
});

useCartStore.subscribe((state) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ cart: { lines: state.lines, invoiceDiscount: state.invoiceDiscount }, checkoutKey: state.checkoutKey }));
  } catch {
    // The cart still works in memory.
  }
});
