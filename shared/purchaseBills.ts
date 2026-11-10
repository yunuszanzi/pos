import { divideRounded, type Paisa } from "./money";
import type { Milli } from "./units";

// The sums behind a supplier's bill: freight spread over its items, input tax, the total, and what it does to the cost of stock.
// The database checks the same sums when it posts (migration 0013), so what a screen previews is what is recorded.

/**
 * Splits `totalPaisa` (freight, say) across lines in proportion to their values, to the whole paisa, so the shares always add up to
 * the total exactly: each line gets the whole paisa of its share, then the paisa left over go to the lines with the largest
 * fractions (earlier line first on a tie). With no value to go by (every line worth nothing) the split is even.
 */
export function allocateByValue(totalPaisa: Paisa, valuesPaisa: Paisa[]): Paisa[] {
  if (valuesPaisa.length === 0) return [];
  if (totalPaisa < 0) throw new RangeError("Nothing can be allocated a negative amount");
  const sum = valuesPaisa.reduce((total, value) => total + BigInt(value), 0n);
  const weights = sum === 0n ? valuesPaisa.map(() => 1n) : valuesPaisa.map((value) => BigInt(value));
  const weightTotal = weights.reduce((total, weight) => total + weight, 0n);
  const total = BigInt(totalPaisa);
  const shares = weights.map((weight) => (total * weight) / weightTotal);
  const fractions = weights.map((weight, index) => ({ index, rest: (total * weight) % weightTotal }));
  let left = Number(total - shares.reduce((acc, share) => acc + share, 0n));
  for (const { index } of fractions.sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1))) {
    if (left <= 0) break;
    shares[index] += 1n;
    left -= 1;
  }
  return shares.map(Number);
}

/** Input tax on a bill line: the line's value times the rate in basis points (1800 = 18%), to the whole paisa. */
export const inputTaxOf = (valuePaisa: Paisa, rateBps: number): Paisa => Number(divideRounded(BigInt(valuePaisa) * BigInt(rateBps), 10_000n));

export type BillTotals = { subtotalPaisa: Paisa; taxPaisa: Paisa; chargesPaisa: Paisa; totalPaisa: Paisa };

/** What a bill adds up to: items, plus tax on the items, plus freight and other charges. The tax is not part of the cost of the goods; the charges are. */
export function billTotals(lines: Array<{ valuePaisa: Paisa; taxPaisa: Paisa }>, chargesPaisa: Paisa[]): BillTotals {
  const subtotalPaisa = lines.reduce((sum, line) => sum + line.valuePaisa, 0);
  const taxPaisa = lines.reduce((sum, line) => sum + line.taxPaisa, 0);
  const charges = chargesPaisa.reduce((sum, amount) => sum + amount, 0);
  return { subtotalPaisa, taxPaisa, chargesPaisa: charges, totalPaisa: subtotalPaisa + taxPaisa + charges };
}

/**
 * What a bill line makes the goods cost per base unit (a piece), to the whole paisa: its value plus its share of the charges, over the
 * quantity in base units. The stock keeps this through a cost adjustment, so it is shown to the person entering the bill.
 */
export function landedCostPerBase(input: { valuePaisa: Paisa; chargeSharePaisa: Paisa; qtyBaseMilli: Milli }): Paisa {
  if (input.qtyBaseMilli <= 0) throw new RangeError("A bill line must bill some quantity");
  return Number(divideRounded(BigInt(input.valuePaisa + input.chargeSharePaisa) * 1000n, BigInt(input.qtyBaseMilli)));
}

/**
 * The value a bill line adds to the stock on hand: what the goods cost on the bill (value plus charges) less what the receipt put the
 * stock in at, for the quantity billed. Positive when the bill is dearer. Only the part still on hand can take it; stock already sold
 * keeps the cost it was sold at, so the value is scaled to min(on hand, billed) / billed.
 */
export function absorbedByStock(input: { valuePaisa: Paisa; chargeSharePaisa: Paisa; qtyBaseMilli: Milli; receiptCostPerBasePaisa: Paisa; onHandMilli: Milli }): Paisa {
  const received = Number(divideRounded(BigInt(input.qtyBaseMilli) * BigInt(input.receiptCostPerBasePaisa), 1000n));
  const delta = input.valuePaisa + input.chargeSharePaisa - received;
  if (delta === 0 || input.onHandMilli <= 0) return 0;
  const covered = Math.min(input.onHandMilli, input.qtyBaseMilli);
  return Number(divideRounded(BigInt(delta) * BigInt(covered), BigInt(input.qtyBaseMilli)));
}
