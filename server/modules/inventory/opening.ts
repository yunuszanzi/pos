import { and, eq, inArray, sql } from "drizzle-orm";
import { locations, productUnits, productVariants, products, stockLedger, units } from "../../../db/schema";
import { csvToRecords, parseCsv } from "../../../shared/csv";
import { lineValue } from "../../../shared/money";
import { analyseOpeningStock, type OpeningStockAnalysis, type OpeningStockLookups } from "../../../shared/openingStockImport";
import { formatQuantity, parseQuantity } from "../../../shared/units";
import type { db } from "../../lib/db";
import type { Principal } from "../../lib/permissions";
import { canSeeCost } from "../products/service";
import { saveAdjustment, type PreparedLine } from "./service";

type Executor = Pick<typeof db, "select" | "selectDistinct" | "insert" | "update" | "execute">;
const lower = (text: string) => text.trim().toLowerCase();

export class OpeningFileError extends Error {}

export async function analyseOpeningFile(executor: Executor, principal: Principal, csv: string): Promise<OpeningStockAnalysis> {
  const businessId = principal.businessId!;
  let parsed: ReturnType<typeof csvToRecords>;
  try {
    parsed = csvToRecords(parseCsv(csv));
  } catch (error) {
    throw new OpeningFileError(error instanceof Error ? error.message : "The file could not be read as CSV");
  }
  const skus = [...new Set(parsed.records.map((record) => record.sku).filter(Boolean).map(lower))];

  const variantRows = skus.length
    ? await executor.select({
      id: productVariants.id, sku: productVariants.sku, active: productVariants.active, costPaisa: productVariants.costPaisa,
      type: products.productType, baseUnitId: products.baseUnitId,
    }).from(productVariants).innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(eq(productVariants.businessId, businessId), inArray(sql`lower(${productVariants.sku})`, skus)))
    : [];
  const variantIds = variantRows.map((row) => row.id);
  const [unitRows, movementRows, locationRows] = await Promise.all([
    variantIds.length
      ? executor.select({ variantId: productUnits.variantId, unitId: productUnits.unitId, factor: productUnits.factorToBase, name: units.name, shortName: units.shortName })
        .from(productUnits).innerJoin(units, eq(units.id, productUnits.unitId)).where(inArray(productUnits.variantId, variantIds))
      : [],
    variantIds.length
      ? executor.selectDistinct({ variantId: stockLedger.variantId, locationId: stockLedger.locationId }).from(stockLedger).where(inArray(stockLedger.variantId, variantIds))
      : [],
    executor.select({ id: locations.id, name: locations.name }).from(locations).where(and(eq(locations.businessId, businessId), eq(locations.active, true))),
  ]);

  const lookups: OpeningStockLookups = {
    variantsBySku: new Map(variantRows.map((variant) => [lower(variant.sku), {
      variantId: variant.id,
      productType: variant.type,
      active: variant.active,
      baseUnitId: variant.baseUnitId,
      costPaisa: variant.costPaisa,
      units: unitRows.filter((unit) => unit.variantId === variant.id)
        .map((unit) => ({ unitId: unit.unitId, name: unit.name, shortName: unit.shortName, factorToBaseMilli: parseQuantity(unit.factor) })),
    }])),
    locationIdsByName: new Map(locationRows.map((location) => [lower(location.name), location.id])),
    defaultLocationId: locationRows.length === 1 ? locationRows[0].id : null,
    withMovements: new Set(movementRows.map((row) => `${row.variantId}|${row.locationId}`)),
    canSetCost: canSeeCost(principal),
  };
  return analyseOpeningStock(parsed.headers, parsed.records, lookups);
}

export type OpeningResult = { locations: number; lines: number; adjustmentIds: string[]; valuePaisa?: number };

/** Posts one approved "opening" adjustment per location. Call inside a transaction with an analysis that has no issues. */
export async function commitOpeningStock(tx: Executor, principal: Principal, analysis: OpeningStockAnalysis): Promise<OpeningResult> {
  const variantIds = [...analysis.byLocation.values()].flatMap((lines) => lines.map((line) => line.variantId));
  const costs = new Map((await tx.select({ id: productVariants.id, cost: productVariants.costPaisa }).from(productVariants)
    .where(inArray(productVariants.id, variantIds))).map((row) => [row.id, row.cost]));

  const adjustmentIds: string[] = [];
  let valuePaisa = 0;
  for (const [locationId, lines] of analysis.byLocation) {
    const prepared: PreparedLine[] = lines.map((line) => {
      const costPerBase = line.costPerBasePaisa ?? costs.get(line.variantId) ?? 0;
      return {
        variantId: line.variantId,
        unitId: line.unitId,
        qtyEntered: line.quantity,
        qtyBaseDelta: formatQuantity(line.baseMilli),
        unitCostPaisa: costPerBase,
        valuePaisa: lineValue(line.baseMilli, costPerBase),
      };
    });
    const totalValuePaisa = prepared.reduce((total, line) => total + line.valuePaisa, 0);
    valuePaisa += totalValuePaisa;
    adjustmentIds.push(await saveAdjustment(tx, principal, { reason: "opening", note: "Opening stock import" }, { locationId, lines: prepared, totalValuePaisa }, true));
  }
  return {
    locations: analysis.byLocation.size,
    lines: analysis.lineCount,
    adjustmentIds,
    ...(canSeeCost(principal) ? { valuePaisa } : {}),
  };
}
