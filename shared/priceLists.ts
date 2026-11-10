import type { Paisa } from "./money";
import type { Milli } from "./units";

// Price tiers (FR-SAL-03, FR-PRD price lists). One rule, used by the till for the live total and by the server when it prices the sale.

export type PriceListItem = { variantId: string; unitId: string; minQuantityMilli: Milli; pricePaisa: Paisa };

/**
 * The tier price of a SKU in a unit for a quantity of that unit: the item with the largest minimum quantity the line reaches
 * ("10+ cartons costs less per carton"). Null when the list has nothing for it, so the shelf price applies.
 */
export function tierPrice(items: readonly PriceListItem[], variantId: string, unitId: string, qtyMilli: Milli): Paisa | null {
  let best: PriceListItem | null = null;
  for (const item of items) {
    if (item.variantId !== variantId || item.unitId !== unitId || item.minQuantityMilli > qtyMilli) continue;
    if (!best || item.minQuantityMilli > best.minQuantityMilli) best = item;
  }
  return best ? best.pricePaisa : null;
}

/** The list a customer buys at: their own, else their group's, else none. */
export function effectivePriceListId(customer: { priceListId: string | null }, group: { priceListId: string | null } | null | undefined): string | null {
  return customer.priceListId ?? group?.priceListId ?? null;
}
