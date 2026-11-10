import { divideRounded, type Paisa } from "./money";
import type { Milli } from "./units";

export type LedgerEntry = {
  variantId: string;
  locationId: string;
  /** Signed, in thousandths of the base unit. */
  qtyMilli: Milli;
  unitCostPaisa: Paisa;
  /**
   * Only on a cost adjustment (quantity zero): value added to, or taken from, the stock on hand, which moves the average without
   * moving any stock. A supplier's bill that differs from the receipt, or carries freight, posts one (migration 0013).
   */
  valueDeltaPaisa?: Paisa;
};

export type StockPosition = { onHandMilli: Milli; avgCostPaisa: Paisa };

export const positionKey = (variantId: string, locationId: string) => `${variantId}|${locationId}`;

/**
 * Applies one movement to a position. Mirrors the apply_stock_ledger_entry trigger in migration 0002:
 * a receipt recalculates the weighted average cost, new_avg = (on_hand x avg + qty x cost) / (on_hand + qty),
 * rounded half away from zero; an issue keeps the average. Negative stock is treated as zero for costing.
 */
export function applyEntry(position: StockPosition, qtyMilli: Milli, unitCostPaisa: Paisa, valueDeltaPaisa: Paisa = 0): StockPosition {
  const onHandMilli = position.onHandMilli + qtyMilli;
  let avgCostPaisa = position.avgCostPaisa;
  if (qtyMilli === 0) {
    // A cost adjustment spreads its value over what is on hand: new_avg = (on_hand x avg + value) / on_hand, never below zero.
    if (valueDeltaPaisa !== 0 && onHandMilli > 0) {
      const value = BigInt(onHandMilli) * BigInt(position.avgCostPaisa) + BigInt(valueDeltaPaisa) * 1000n;
      avgCostPaisa = Math.max(Number(divideRounded(value, BigInt(onHandMilli))), 0);
    }
  } else if (qtyMilli > 0 && onHandMilli > 0) {
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
    positions.set(key, applyEntry(positions.get(key) ?? { onHandMilli: 0, avgCostPaisa: 0 }, entry.qtyMilli, entry.unitCostPaisa, entry.valueDeltaPaisa));
  }
  return positions;
}
