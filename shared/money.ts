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

/** 123450 -> "1234.50": no thousands separators, for CSV cells and form inputs. */
export function toPlainRupees(paisa: Paisa): string {
  return formatRupees(paisa).replaceAll(",", "");
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

/** "18" -> 1800, "7.5" -> 750, "0.25" -> 25. Tax rates are stored as integer basis points; at most two decimals of a percent. */
export function parsePercentToBps(input: string): number {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) throw new RangeError(`"${input}" is not a valid percentage`);
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (bps > 10000) throw new RangeError("A rate cannot exceed 100%");
  return bps;
}

/** 1800 -> "18", 750 -> "7.5", 25 -> "0.25". */
export function formatBps(bps: number): string {
  assertPaisa(bps, "rate");
  const fraction = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return `${Math.trunc(bps / 100)}${fraction ? `.${fraction}` : ""}`;
}
