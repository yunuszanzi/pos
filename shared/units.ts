// Quantities and conversion factors are numeric(14,3) in the database. Here they are integers of
// thousandths ("milli") so arithmetic stays exact. Stock is always kept in the product's base unit.

export type Milli = number;

/** "2.5" -> 2500. At most three decimals, non-negative. */
export function parseQuantity(input: string): Milli {
  const match = /^(\d{1,11})(?:\.(\d{1,3}))?$/.exec(input.trim());
  if (!match) throw new RangeError(`"${input}" is not a valid quantity`);
  return Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
}

/** 2500 -> "2.5", 2000000 -> "2000". Matches how Postgres numeric(14,3) values are shown, minus trailing zeros. */
export function formatQuantity(milli: Milli): string {
  if (!Number.isSafeInteger(milli)) throw new RangeError("Quantity must be an exact number of thousandths");
  const negative = milli < 0;
  const absolute = Math.abs(milli);
  const whole = Math.trunc(absolute / 1000);
  const fraction = (absolute % 1000).toString().padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Quantity in the sold/bought unit -> quantity in the base unit.
 * 10 cartons at 200 pieces per carton is 2000 pieces. Throws if the result is not a whole number of
 * thousandths, since stock cannot hold finer quantities than the database column.
 */
export function toBaseQuantity(quantityMilli: Milli, factorToBaseMilli: Milli): Milli {
  if (factorToBaseMilli <= 0) throw new RangeError("Conversion factor must be positive");
  const product = BigInt(quantityMilli) * BigInt(factorToBaseMilli);
  if (product % 1000n !== 0n) throw new RangeError("Quantity does not convert to a whole number of base units");
  const result = product / 1000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Quantity is too large");
  }
  return Number(result);
}

export type UnitBreakdown = { unitId: string; quantityMilli: Milli };

/**
 * Express a base quantity in whole larger units plus a remainder, largest first.
 * 2,050 pieces with carton = 200 and pack = 10 gives 10 cartons, 5 packs, 0 pieces.
 */
export function breakDownQuantity(
  baseMilli: Milli,
  units: Array<{ unitId: string; factorToBaseMilli: Milli }>,
): UnitBreakdown[] {
  let remaining = BigInt(baseMilli);
  const result: UnitBreakdown[] = [];
  for (const unit of [...units].sort((a, b) => b.factorToBaseMilli - a.factorToBaseMilli)) {
    const factor = BigInt(unit.factorToBaseMilli);
    if (factor <= 0n) throw new RangeError("Conversion factor must be positive");
    if (factor === 1000n) {
      if (remaining > 0n) result.push({ unitId: unit.unitId, quantityMilli: Number(remaining) });
      remaining = 0n;
      continue;
    }
    const whole = remaining / factor;
    if (whole > 0n) {
      result.push({ unitId: unit.unitId, quantityMilli: Number(whole * 1000n) });
      remaining -= whole * factor;
    }
  }
  return result;
}
