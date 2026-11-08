import { divideRounded, lineValue, type Paisa } from "./money";
import type { Milli } from "./units";

// The sums behind buying. Money is whole paisa; quantities are thousandths (shared/units.ts). The database does the same sums
// when it posts, so what a screen previews is what is recorded.

export const poStatuses = ["draft", "sent", "partly_received", "received", "closed", "cancelled"] as const;
export type PoStatus = (typeof poStatuses)[number];

export const poStatusLabels: Record<PoStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  partly_received: "Partly received",
  received: "Received",
  closed: "Closed",
  cancelled: "Cancelled",
};

/** What a line is worth to the supplier: the quantity in the unit it was bought in, times the price of one such unit. */
export const purchaseLineValue = (quantityMilli: Milli, unitCostPaisa: Paisa): Paisa => lineValue(quantityMilli, unitCostPaisa);

/** The cost of one base unit (one piece) from the price of a bought unit (one carton of `factorToBaseMilli`/1000 pieces), to the whole paisa. */
export function costPerBaseUnit(unitCostPaisa: Paisa, factorToBaseMilli: Milli): Paisa {
  if (factorToBaseMilli <= 0) throw new RangeError("A unit must hold more than nothing");
  return Number(divideRounded(BigInt(unitCostPaisa) * 1000n, BigInt(factorToBaseMilli)));
}

/**
 * The weighted average cost after goods come in, to the whole paisa:
 *   new average = (on hand x average + received x cost) / (on hand + received)
 * Stock below zero counts as nothing held, so a receipt after overselling starts from the cost it came in at. This is the
 * formula the stock ledger trigger applies (migration 0002); the screens use it to preview.
 */
export function averageAfterReceipt(input: { onHandMilli: Milli; averagePaisa: Paisa; receivedMilli: Milli; costPaisa: Paisa }): Paisa {
  const held = Math.max(input.onHandMilli, 0);
  if (input.receivedMilli <= 0) return input.averagePaisa;
  const value = BigInt(held) * BigInt(input.averagePaisa) + BigInt(input.receivedMilli) * BigInt(input.costPaisa);
  return Number(divideRounded(value, BigInt(held + input.receivedMilli)));
}

/** How much of an ordered line is still to come, in base units. */
export const remainingToReceive = (line: { qtyBase: Milli; receivedBase: Milli }): Milli => Math.max(line.qtyBase - line.receivedBase, 0);

/** The status an order takes once receipts are in: received when every line is complete, partly received when anything has come. */
export function statusAfterReceipt(lines: Array<{ qtyBase: Milli; receivedBase: Milli }>): "sent" | "partly_received" | "received" {
  if (lines.length > 0 && lines.every((line) => line.receivedBase >= line.qtyBase)) return "received";
  return lines.some((line) => line.receivedBase > 0) ? "partly_received" : "sent";
}

export const orderTotal = (lines: Array<{ valuePaisa: Paisa }>): Paisa => lines.reduce((sum, line) => sum + line.valuePaisa, 0);

/** The price of one bought unit (a carton) suggested from the cost of one base unit (a piece): the other way round from costPerBaseUnit. */
export function unitCostFromBase(costPerBasePaisa: Paisa, factorToBaseMilli: Milli): Paisa {
  return Number(divideRounded(BigInt(costPerBasePaisa) * BigInt(factorToBaseMilli), 1000n));
}
