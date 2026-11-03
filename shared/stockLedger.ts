import { divideRounded, type Paisa } from "./money";
import type { Milli } from "./units";

export type LedgerEntry = {
  variantId: string;
  locationId: string;
  /** Signed, in thousandths of the base unit. */
  qtyMilli: Milli;
  unitCostPaisa: Paisa;
};

export type StockPosition = { onHandMilli: Milli; avgCostPaisa: Paisa };

export const positionKey = (variantId: string, locationId: string) => `${variantId}|${locationId}`;

/**
 * Applies one movement to a position. Mirrors the apply_stock_ledger_entry trigger in migration 0002:
 * a receipt recalculates the weighted average cost, new_avg = (on_hand x avg + qty x cost) / (on_hand + qty),
 * rounded half away from zero; an issue keeps the average. Negative stock is treated as zero for costing.
 */
export function applyEntry(position: StockPosition, qtyMilli: Milli, unitCostPaisa: Paisa): StockPosition {
  const onHandMilli = position.onHandMilli + qtyMilli;
  let avgCostPaisa = position.avgCostPaisa;
  if (qtyMilli > 0 && onHandMilli > 0) {
    const existing = BigInt(Math.max(position.onHandMilli, 0));
    avgCostPaisa = Number(divideRounded(
      existing * BigInt(position.avgCostPaisa) + BigInt(qtyMilli) * BigInt(unitCostPaisa),
      existing + BigInt(qtyMilli),
    ));
  }
  return { onHandMilli, avgCostPaisa };
}

/** Rebuilds balances from the ledger, which must be in posting order. Used for "valuation as of a date" and to cross-check the cached balances. */
export function replayStockLedger(entries: Iterable<LedgerEntry>): Map<string, StockPosition> {
  const positions = new Map<string, StockPosition>();
  for (const entry of entries) {
    const key = positionKey(entry.variantId, entry.locationId);
    positions.set(key, applyEntry(positions.get(key) ?? { onHandMilli: 0, avgCostPaisa: 0 }, entry.qtyMilli, entry.unitCostPaisa));
  }
  return positions;
}
