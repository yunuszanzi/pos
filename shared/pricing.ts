import { divideRounded, type Paisa } from "./money";
import type { Milli } from "./units";

// The one place pricing, discount and tax maths lives. The POS screen uses it for the live total and the server
// uses it as the source of truth, so a tampered browser cannot change a price. Integers only: amounts are paisa
// (rounded half away from zero to the whole paisa) and quantities are thousandths.
//
// Order of calculation for each line:
//   gross            = quantity x unit price
//   line discount    = % of gross, or a fixed amount
//   invoice discount = % of the lines after their own discounts, or fixed; shared across lines by value
//   net              = gross - line discount - share of invoice discount
//   tax exclusive    : tax = net x rate, total = net + tax
//   tax inclusive    : prices already contain tax: taxable = net / (1 + rate), tax = net - taxable, total = net

export type TaxMode = "inclusive" | "exclusive";
export type Discount = { type: "percent"; bps: number } | { type: "fixed"; paisa: Paisa };

/** Cash totals can round to the nearest 1, 5 or 10 rupees (FR-SAL-16). 0 means no rounding. */
export const cashRoundingSteps = [0, 100, 500, 1000] as const;
export type CashRoundingStep = (typeof cashRoundingSteps)[number];

export class PricingError extends Error {
  constructor(readonly code: "INVALID_LINE" | "INVALID_DISCOUNT" | "DISCOUNT_EXCEEDS_VALUE" | "EMPTY_CART", message: string) {
    super(message);
  }
}

export type PricingLine = {
  /** In the unit being sold, in thousandths. */
  qtyMilli: Milli;
  /** Per sold unit. */
  unitPricePaisa: Paisa;
  taxRateBps: number;
  discount?: Discount | null;
};

export type PricingInput = {
  lines: PricingLine[];
  invoiceDiscount?: Discount | null;
  taxMode: TaxMode;
  cashRounding?: CashRoundingStep;
};

export type PricedLine = {
  grossPaisa: Paisa;
  lineDiscountPaisa: Paisa;
  invoiceDiscountSharePaisa: Paisa;
  /** gross less both discounts. */
  netPaisa: Paisa;
  /** The value the tax is charged on. */
  taxablePaisa: Paisa;
  taxPaisa: Paisa;
  /** What the customer pays for this line. */
  totalPaisa: Paisa;
};

export type PricedCart = {
  lines: PricedLine[];
  grossPaisa: Paisa;
  lineDiscountPaisa: Paisa;
  invoiceDiscountPaisa: Paisa;
  /** Line and invoice discounts together. */
  discountPaisa: Paisa;
  taxablePaisa: Paisa;
  taxPaisa: Paisa;
  beforeRoundingPaisa: Paisa;
  /** Added to reach the cash step: negative rounds down. Shown on the bill. */
  roundingPaisa: Paisa;
  totalPaisa: Paisa;
};

const big = (value: number) => BigInt(value);

/** Back to a number, refusing anything a number cannot hold exactly: a silently rounded amount would be a wrong bill. */
function exact(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PricingError("INVALID_LINE", "An amount is too large to calculate exactly");
  }
  return Number(value);
}

const sum = (values: number[]) => exact(values.reduce((total, value) => total + big(value), 0n));

function requireWhole(value: number, what: string, code: PricingError["code"] = "INVALID_LINE") {
  if (!Number.isSafeInteger(value)) throw new PricingError(code, `${what} must be a whole number`);
}

/** How much a discount takes off a base amount. Throws if it would take off more than the base. */
export function discountAmount(discount: Discount | null | undefined, basePaisa: Paisa): Paisa {
  if (!discount) return 0;
  let amount: Paisa;
  if (discount.type === "percent") {
    requireWhole(discount.bps, "A discount percentage", "INVALID_DISCOUNT");
    if (discount.bps < 0 || discount.bps > 10000) throw new PricingError("INVALID_DISCOUNT", "A discount percentage must be between 0 and 100");
    amount = exact(divideRounded(big(basePaisa) * big(discount.bps), 10000n));
  } else {
    requireWhole(discount.paisa, "A discount amount", "INVALID_DISCOUNT");
    if (discount.paisa < 0) throw new PricingError("INVALID_DISCOUNT", "A discount cannot be negative");
    amount = discount.paisa;
  }
  if (amount > basePaisa) throw new PricingError("DISCOUNT_EXCEEDS_VALUE", "A discount cannot be more than the amount it is taken from");
  return amount;
}

/**
 * Splits `total` across `weights` in proportion, in whole paisa, so the parts add up to `total` exactly: each part is
 * rounded down and the paisa left over go to the largest remainders (the earlier line wins a tie).
 */
export function allocateProportionally(total: Paisa, weights: Paisa[]): Paisa[] {
  if (total === 0) return weights.map(() => 0);
  const weightSum = big(sum(weights));
  if (weightSum === 0n) throw new PricingError("DISCOUNT_EXCEEDS_VALUE", "There is nothing to share a discount across");
  const parts = weights.map((weight) => ({ floor: (big(total) * big(weight)) / weightSum, remainder: (big(total) * big(weight)) % weightSum }));
  let left = big(total) - parts.reduce((running, part) => running + part.floor, 0n);
  const order = parts.map((_, index) => index).sort((a, b) => (parts[b].remainder > parts[a].remainder ? 1 : parts[b].remainder < parts[a].remainder ? -1 : a - b));
  const result = parts.map((part) => part.floor);
  for (const index of order) {
    if (left === 0n) break;
    result[index] += 1n;
    left -= 1n;
  }
  return result.map(Number);
}

/** Rounds a total to a cash step; the second value is what was added to get there. */
export function roundToCashStep(totalPaisa: Paisa, step: CashRoundingStep): { totalPaisa: Paisa; roundingPaisa: Paisa } {
  if (step === 0) return { totalPaisa, roundingPaisa: 0 };
  const rounded = exact(divideRounded(big(totalPaisa), big(step)) * big(step));
  return { totalPaisa: rounded, roundingPaisa: rounded - totalPaisa };
}

export function priceCart(input: PricingInput): PricedCart {
  if (!input.lines.length) throw new PricingError("EMPTY_CART", "Add at least one item");
  for (const [index, line] of input.lines.entries()) {
    const label = `Line ${index + 1}`;
    requireWhole(line.qtyMilli, `${label}: the quantity`);
    requireWhole(line.unitPricePaisa, `${label}: the price`);
    requireWhole(line.taxRateBps, `${label}: the tax rate`);
    if (line.qtyMilli <= 0) throw new PricingError("INVALID_LINE", `${label}: the quantity must be more than zero`);
    if (line.unitPricePaisa < 0) throw new PricingError("INVALID_LINE", `${label}: the price cannot be negative`);
    if (line.taxRateBps < 0 || line.taxRateBps > 10000) throw new PricingError("INVALID_LINE", `${label}: the tax rate must be between 0 and 100`);
  }

  const grosses = input.lines.map((line) => exact(divideRounded(big(line.qtyMilli) * big(line.unitPricePaisa), 1000n)));
  const lineDiscounts = input.lines.map((line, index) => discountAmount(line.discount, grosses[index]));
  const afterLine = grosses.map((gross, index) => gross - lineDiscounts[index]);
  const invoiceDiscountPaisa = discountAmount(input.invoiceDiscount, sum(afterLine));
  const shares = allocateProportionally(invoiceDiscountPaisa, afterLine);

  const lines = input.lines.map((line, index): PricedLine => {
    const netPaisa = afterLine[index] - shares[index];
    if (input.taxMode === "exclusive") {
      const taxPaisa = exact(divideRounded(big(netPaisa) * big(line.taxRateBps), 10000n));
      return { grossPaisa: grosses[index], lineDiscountPaisa: lineDiscounts[index], invoiceDiscountSharePaisa: shares[index], netPaisa, taxablePaisa: netPaisa, taxPaisa, totalPaisa: netPaisa + taxPaisa };
    }
    const taxablePaisa = exact(divideRounded(big(netPaisa) * 10000n, big(10000 + line.taxRateBps)));
    return { grossPaisa: grosses[index], lineDiscountPaisa: lineDiscounts[index], invoiceDiscountSharePaisa: shares[index], netPaisa, taxablePaisa, taxPaisa: netPaisa - taxablePaisa, totalPaisa: netPaisa };
  });

  const beforeRoundingPaisa = sum(lines.map((line) => line.totalPaisa));
  const rounded = roundToCashStep(beforeRoundingPaisa, input.cashRounding ?? 0);
  const lineDiscountPaisa = sum(lineDiscounts);
  return {
    lines,
    grossPaisa: sum(grosses),
    lineDiscountPaisa,
    invoiceDiscountPaisa,
    discountPaisa: lineDiscountPaisa + invoiceDiscountPaisa,
    taxablePaisa: sum(lines.map((line) => line.taxablePaisa)),
    taxPaisa: sum(lines.map((line) => line.taxPaisa)),
    beforeRoundingPaisa,
    roundingPaisa: rounded.roundingPaisa,
    totalPaisa: rounded.totalPaisa,
  };
}

/** A discount as a percentage of what it is taken from, in basis points, rounded up so a limit is never slipped under. */
export function discountPercentBps(discount: Discount, basePaisa: Paisa): number {
  if (discount.type === "percent") return discount.bps;
  if (discount.paisa === 0) return 0;
  if (basePaisa <= 0) throw new PricingError("DISCOUNT_EXCEEDS_VALUE", "There is nothing to take a discount from");
  const scaled = big(discount.paisa) * 10000n;
  return Number((scaled + big(basePaisa) - 1n) / big(basePaisa));
}

export type DiscountBreach = { scope: "line"; lineIndex: number; bps: number } | { scope: "invoice"; bps: number };

/** Which discounts are bigger than a role's limit (FR-SAL-04). Those need a manager's approval. */
export function discountsOverLimit(input: PricingInput, priced: PricedCart, limitBps: number): DiscountBreach[] {
  const breaches: DiscountBreach[] = [];
  input.lines.forEach((line, lineIndex) => {
    if (!line.discount) return;
    const bps = discountPercentBps(line.discount, priced.lines[lineIndex].grossPaisa);
    if (bps > limitBps) breaches.push({ scope: "line", lineIndex, bps });
  });
  if (input.invoiceDiscount) {
    const base = priced.lines.reduce((total, line) => total + line.grossPaisa - line.lineDiscountPaisa, 0);
    const bps = discountPercentBps(input.invoiceDiscount, base);
    if (bps > limitBps) breaches.push({ scope: "invoice", bps });
  }
  return breaches;
}
