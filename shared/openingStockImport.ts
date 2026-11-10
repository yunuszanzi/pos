import { divideRounded, parseRupees, type Paisa } from "./money";
import { formatQuantity, parseQuantity, toBaseQuantity, type Milli } from "./units";

// Opening stock for go-live (FR-INV-09), by CSV. One row per SKU and location. Quantities are in the unit named
// on the row, so "10 Carton" becomes 2,000 pieces. All-or-nothing, and only for SKUs that have no stock movements yet.

export const openingStockColumns = ["sku", "quantity", "unit", "cost", "location"] as const;
export const maxOpeningStockRows = 5000;

export type OpeningStockIssue = { row: number; field: string; message: string };

export type OpeningStockLookups = {
  variantsBySku: Map<string, {
    variantId: string;
    productType: "stocked" | "non_stock" | "service";
    active: boolean;
    baseUnitId: string;
    costPaisa: Paisa;
    units: Array<{ unitId: string; name: string; shortName: string; factorToBaseMilli: Milli }>;
  }>;
  /** lower-case location name -> id, active locations only */
  locationIdsByName: Map<string, string>;
  /** Set when the business has exactly one active location, so the column can be left out. */
  defaultLocationId: string | null;
  /** `${variantId}|${locationId}` pairs that already have ledger entries. */
  withMovements: Set<string>;
  canSetCost: boolean;
};

export type OpeningStockLine = {
  row: number;
  variantId: string;
  unitId: string;
  /** As entered, e.g. "10". */
  quantity: string;
  /** Always positive, in the base unit. */
  baseMilli: Milli;
  /** Per base unit; null means "use the SKU's catalogue cost". */
  costPerBasePaisa: Paisa | null;
};

export type OpeningStockAnalysis = {
  issues: OpeningStockIssue[];
  byLocation: Map<string, OpeningStockLine[]>;
  lineCount: number;
};

const key = (text: string) => text.trim().toLowerCase();

export function analyseOpeningStock(headers: string[], records: Array<Record<string, string>>, lookups: OpeningStockLookups): OpeningStockAnalysis {
  const issues: OpeningStockIssue[] = [];
  const empty = (): OpeningStockAnalysis => ({ issues, byLocation: new Map(), lineCount: 0 });
  const fileIssue = (field: string, message: string) => issues.push({ row: 1, field, message });

  for (const column of ["sku", "quantity"]) {
    if (!headers.includes(column)) fileIssue(column, `The "${column}" column is required`);
  }
  for (const header of headers) {
    if (header && !(openingStockColumns as readonly string[]).includes(header)) {
      fileIssue(header, `Unknown column "${header}". Expected: ${openingStockColumns.join(", ")}`);
    }
  }
  if (!records.length) fileIssue("file", "The file has a header but no stock rows");
  if (records.length > maxOpeningStockRows) fileIssue("file", `At most ${maxOpeningStockRows} rows can be imported at once; this file has ${records.length}`);
  if (issues.length) return empty();

  const byLocation = new Map<string, OpeningStockLine[]>();
  const seen = new Map<string, number>();
  let lineCount = 0;

  records.forEach((record, index) => {
    const row = index + 2;
    const problem = (field: string, message: string) => issues.push({ row, field, message });
    const sku = record.sku ?? "";
    if (!sku) return problem("sku", "SKU is required");

    const variant = lookups.variantsBySku.get(key(sku));
    if (!variant) return problem("sku", `Unknown SKU "${sku}". Import the product first`);
    if (!variant.active) problem("sku", `SKU "${sku}" is archived`);
    if (variant.productType !== "stocked") problem("sku", `SKU "${sku}" is not a stocked item, so it has no stock`);

    let locationId = lookups.defaultLocationId;
    if (record.location) {
      locationId = lookups.locationIdsByName.get(key(record.location)) ?? null;
      if (!locationId) problem("location", `Unknown location "${record.location}"`);
    } else if (!locationId) {
      problem("location", "Name the location; this business has more than one");
    }

    const unitName = record.unit;
    const unit = unitName
      ? variant.units.find((candidate) => key(candidate.name) === key(unitName) || key(candidate.shortName) === key(unitName))
      : variant.units.find((candidate) => candidate.unitId === variant.baseUnitId);
    if (unitName && !unit) problem("unit", `"${sku}" is not sold in "${unitName}". Its units: ${variant.units.map((candidate) => candidate.name).join(", ")}`);

    let quantity = "";
    let baseMilli = 0;
    try {
      quantity = formatQuantity(parseQuantity(record.quantity ?? ""));
      if (parseQuantity(quantity) <= 0) problem("quantity", "Quantity must be greater than zero");
      else if (unit) baseMilli = toBaseQuantity(parseQuantity(quantity), unit.factorToBaseMilli);
    } catch {
      problem("quantity", `"${record.quantity ?? ""}" is not a valid quantity`);
    }

    let costPerBasePaisa: Paisa | null = null;
    if (record.cost) {
      if (!lookups.canSetCost) problem("cost", "You do not have permission to import cost prices; leave this column empty");
      else if (unit && baseMilli > 0) {
        try {
          // The cost column is per entered unit (per carton when the unit is Carton); store it per base unit.
          const perUnit = parseRupees(record.cost);
          if (perUnit < 0) problem("cost", "Cost cannot be negative");
          else costPerBasePaisa = Number(divideRounded(BigInt(perUnit) * 1000n, BigInt(unit.factorToBaseMilli)));
        } catch {
          problem("cost", `"${record.cost}" is not a valid amount`);
        }
      }
    }

    if (!locationId) return;
    const pair = `${variant.variantId}|${locationId}`;
    if (lookups.withMovements.has(pair)) problem("sku", `"${sku}" already has stock movements here; use a stock adjustment instead`);
    const firstSeen = seen.get(pair);
    if (firstSeen) problem("sku", `"${sku}" already appears on row ${firstSeen} for this location`);
    else seen.set(pair, row);

    if (!unit || baseMilli <= 0) return;
    const lines = byLocation.get(locationId) ?? [];
    lines.push({ row, variantId: variant.variantId, unitId: unit.unitId, quantity, baseMilli, costPerBasePaisa });
    byLocation.set(locationId, lines);
    lineCount += 1;
  });

  return { issues, byLocation, lineCount };
}

export const openingStockTemplateRows: string[][] = [
  [...openingStockColumns],
  ["BAL-12-RED", "10", "Carton", "3200.00", ""],
  ["BAL-12-BLU", "500", "Piece", "", ""],
];
