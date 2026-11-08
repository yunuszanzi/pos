import { z } from "zod";
import { priceCart, type CashRoundingStep, type Discount, type PricedCart, type TaxMode } from "../../shared/pricing";
import type { PostSaleInput } from "../../shared/schemas/sales";
import { discountSchema } from "../../shared/schemas/sales";
import { formatQuantity } from "../../shared/units";
import type { CatalogueEntry, CatalogueIndex } from "./catalogueIndex";

export type CartLine = {
  /** Identifies the row on screen; not the product. */
  key: string;
  variantId: string;
  unitId: string;
  quantityMilli: number;
  /** A price typed over the shelf price; only honoured by the server for people who may change prices. */
  priceOverridePaisa: number | null;
  discount: Discount | null;
};

export type Cart = { lines: CartLine[]; invoiceDiscount: Discount | null };

export const emptyCart: Cart = { lines: [], invoiceDiscount: null };

const newKey = () => crypto.randomUUID();

/** Adds an item; scanning the same item again raises its quantity instead of adding a second row. */
export function addEntry(cart: Cart, entry: Pick<CatalogueEntry, "variantId" | "unitId">, quantityMilli = 1000): Cart {
  const existing = cart.lines.find((line) => line.variantId === entry.variantId && line.unitId === entry.unitId && !line.priceOverridePaisa && !line.discount);
  if (existing) return { ...cart, lines: cart.lines.map((line) => (line === existing ? { ...line, quantityMilli: line.quantityMilli + quantityMilli } : line)) };
  return { ...cart, lines: [...cart.lines, { key: newKey(), variantId: entry.variantId, unitId: entry.unitId, quantityMilli, priceOverridePaisa: null, discount: null }] };
}

export function updateLine(cart: Cart, key: string, change: Partial<Omit<CartLine, "key" | "variantId">>): Cart {
  return { ...cart, lines: cart.lines.map((line) => (line.key === key ? { ...line, ...change } : line)) };
}

export function removeLine(cart: Cart, key: string): Cart {
  return { ...cart, lines: cart.lines.filter((line) => line.key !== key) };
}

export type PricedCartLine = { line: CartLine; entry: CatalogueEntry; unitPricePaisa: number };
export type CartTotals = { priced: PricedCart; lines: PricedCartLine[]; /** Lines whose product is no longer in the catalogue. */ missing: CartLine[] };

/** The live totals, from the same engine the server uses, so the figure at the till is the figure on the bill. Null while there is nothing to price. */
export function totalsOf(cart: Cart, catalogue: CatalogueIndex, taxMode: TaxMode, cashRounding: CashRoundingStep): CartTotals | null {
  const lines: PricedCartLine[] = [];
  const missing: CartLine[] = [];
  for (const line of cart.lines) {
    const entry = catalogue.get(line.variantId, line.unitId);
    if (!entry) missing.push(line);
    else lines.push({ line, entry, unitPricePaisa: line.priceOverridePaisa ?? entry.pricePaisa });
  }
  if (!lines.length) return null;
  const priced = priceCart({
    taxMode,
    cashRounding,
    invoiceDiscount: cart.invoiceDiscount,
    lines: lines.map(({ line, entry, unitPricePaisa }) => ({ qtyMilli: line.quantityMilli, unitPricePaisa, taxRateBps: entry.taxRateBps, discount: line.discount })),
  });
  return { priced, lines, missing };
}

export type Tendered = { methodId: string; amountPaisa: number; reference?: string };

export function toSaleRequest(
  cart: Cart, shiftId: string, payments: Tendered[], extra: { expectedTotalPaisa?: number; approval?: PostSaleInput["approval"] } = {},
): PostSaleInput {
  return {
    shiftId,
    lines: cart.lines.map((line) => ({
      variantId: line.variantId,
      unitId: line.unitId,
      quantity: formatQuantity(line.quantityMilli),
      ...(line.priceOverridePaisa !== null ? { unitPricePaisa: line.priceOverridePaisa } : {}),
      ...(line.discount ? { discount: line.discount } : {}),
    })),
    ...(cart.invoiceDiscount ? { invoiceDiscount: cart.invoiceDiscount } : {}),
    payments: payments.map((payment) => ({ methodId: payment.methodId, amountPaisa: payment.amountPaisa, reference: payment.reference ?? "" })),
    ...extra,
  };
}

const cartSchema = z.object({
  lines: z.array(z.object({
    key: z.string().min(1),
    variantId: z.string().uuid(),
    unitId: z.string().uuid(),
    quantityMilli: z.number().int().positive(),
    priceOverridePaisa: z.number().int().min(0).nullable(),
    discount: discountSchema.nullable(),
  })),
  invoiceDiscount: discountSchema.nullable(),
});

/** A cart read back from storage or from a held sale. It came from outside, so its shape is checked; a bad one is dropped, not trusted. */
export function parseStoredCart(value: unknown): Cart | null {
  const parsed = cartSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
