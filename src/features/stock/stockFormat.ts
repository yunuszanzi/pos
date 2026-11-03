import { breakDownQuantity, formatQuantity, parseQuantity, parseSignedQuantity } from "../../../shared/units";

/** "2000" -> "2,000", "-1234.5" -> "-1,234.5". Works on the text so large quantities never pass through a float. */
export function groupDigits(quantity: string): string {
  const [whole, fraction] = quantity.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const grouped = whole.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${fraction ? `.${fraction}` : ""}`;
}

export const adjustmentReasonLabels: Record<string, string> = {
  damage: "Damaged",
  theft: "Theft or loss",
  expiry: "Expired",
  found: "Stock found",
  correction: "Count correction",
  opening: "Opening stock",
};

export const documentLabels: Record<string, string> = {
  stock_adjustment: "Stock adjustment",
};

/**
 * Stock in the base unit, plus the same quantity in larger units when it makes a whole one:
 * 2,050 pieces is "2,050 Piece" with the detail "10 Carton + 5 Pack".
 */
export function describeStock(
  onHand: string,
  units: Array<{ unitId: string; factorToBase: string; isBase: boolean }>,
  unitName: (unitId: string) => string,
): { main: string; detail: string } {
  const base = units.find((unit) => unit.isBase);
  const main = `${groupDigits(onHand)}${base ? ` ${unitName(base.unitId)}` : ""}`;
  if (!base || units.length < 2 || onHand.startsWith("-")) return { main, detail: "" };
  const parts = breakDownQuantity(
    parseSignedQuantity(onHand),
    units.map((unit) => ({ unitId: unit.unitId, factorToBaseMilli: parseQuantity(unit.factorToBase) })),
  );
  // Only worth showing when at least one larger unit is used.
  if (!parts.some((part) => part.unitId !== base.unitId)) return { main, detail: "" };
  return { main, detail: parts.map((part) => `${groupDigits(formatQuantity(part.quantityMilli))} ${unitName(part.unitId)}`).join(" + ") };
}
