// Money is an integer number of paisa everywhere. Strings are parsed digit by digit, never through floats.

export type Paisa = number;

export function assertPaisa(value: number, label = "amount"): Paisa {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a whole number of paisa`);
  return value;
}

/** "1234.5" or "1,234.50" (rupees) -> 123450. At most two decimal places; throws on anything else. */
export function parseRupees(input: string): Paisa {
  const match = /^(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) throw new RangeError(`"${input}" is not a valid rupee amount`);
  const [, sign, whole, fraction = ""] = match;
  const paisa = Number(whole.replaceAll(",", "")) * 100 + Number(fraction.padEnd(2, "0"));
  return assertPaisa(sign ? -paisa : paisa);
}

/** 123450 -> "1,234.50" (no currency symbol). */
export function formatRupees(paisa: Paisa): string {
  assertPaisa(paisa);
  const negative = paisa < 0;
  const absolute = Math.abs(paisa);
  const whole = Math.trunc(absolute / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (absolute % 100).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function formatPkr(paisa: Paisa): string {
  return `Rs ${formatRupees(paisa)}`;
}

/** Integer division rounding half away from zero, for splitting or scaling amounts without floats. */
export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("Division by zero");
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (2n * n + d) / (2n * d);
  return negative ? -quotient : quotient;
}

/** Value of `quantityMilli` thousandths of a unit at `unitCostPaisa`, rounded to the paisa. */
export function lineValue(quantityMilli: number, unitCostPaisa: Paisa): Paisa {
  return Number(divideRounded(BigInt(quantityMilli) * BigInt(unitCostPaisa), 1000n));
}
