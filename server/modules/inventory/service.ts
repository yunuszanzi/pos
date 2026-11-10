import { and, eq, inArray, sql } from "drizzle-orm";
import {
  businessSettings, locations, productUnits, productVariants, products, stockAdjustmentLines, stockAdjustments, stockBalances, appUsers,
} from "../../../db/schema";
import { divideRounded, lineValue, type Paisa } from "../../../shared/money";
import type { StockAdjustmentInput } from "../../../shared/schemas/inventory";
import { formatQuantity, parseQuantity, toBaseQuantity } from "../../../shared/units";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { getActorId, hasPermission, type Principal } from "../../lib/permissions";
import { canSeeCost, quantityText } from "../products/service";

/** "-2.500" -> "-2.5", "10.000" -> "10". */
export const signedQuantityText = (value: string) => (value.startsWith("-") ? `-${quantityText(value.slice(1))}` : quantityText(value));

type Executor = Pick<typeof db, "select" | "insert" | "update" | "execute">;

export class InventoryRuleError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

export type PreparedLine = {
  variantId: string;
  unitId: string;
  /** Signed, as entered. */
  qtyEntered: string;
  /** Signed, in the base unit. */
  qtyBaseDelta: string;
  /** Per base unit. */
  unitCostPaisa: Paisa;
  valuePaisa: Paisa;
};
export type PreparedAdjustment = { locationId: string; lines: PreparedLine[]; totalValuePaisa: Paisa };

/** Checks an adjustment request against the catalogue and works out base quantities and values. Nothing is written. */
export async function prepareAdjustment(
  executor: Executor,
  principal: Principal,
  input: { locationId: string; lines: StockAdjustmentInput["lines"] },
): Promise<PreparedAdjustment> {
  const businessId = principal.businessId!;
  const [location] = await executor.select({ id: locations.id }).from(locations)
    .where(and(eq(locations.id, input.locationId), eq(locations.businessId, businessId), eq(locations.active, true))).limit(1);
  if (!location) throw new InventoryRuleError("INVALID_LOCATION", "Choose an active stock location in this business");

  const variantIds = input.lines.map((line) => line.variantId);
  const [variantRows, unitRows, balanceRows] = await Promise.all([
    executor.select({ id: productVariants.id, sku: productVariants.sku, costPaisa: productVariants.costPaisa, active: productVariants.active, type: products.productType })
      .from(productVariants).innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(eq(productVariants.businessId, businessId), inArray(productVariants.id, variantIds))),
    executor.select({ variantId: productUnits.variantId, unitId: productUnits.unitId, factor: productUnits.factorToBase }).from(productUnits)
      .where(and(eq(productUnits.businessId, businessId), inArray(productUnits.variantId, variantIds))),
    executor.select({ variantId: stockBalances.variantId, avg: stockBalances.avgCostPaisa, onHand: stockBalances.onHand }).from(stockBalances)
      .where(and(eq(stockBalances.locationId, input.locationId), inArray(stockBalances.variantId, variantIds))),
  ]);
  const variants = new Map(variantRows.map((row) => [row.id, row]));
  const factors = new Map(unitRows.map((row) => [`${row.variantId}|${row.unitId}`, row.factor]));
  const balances = new Map(balanceRows.map((row) => [row.variantId, row]));
  const withCost = canSeeCost(principal);

  const lines = input.lines.map((line): PreparedLine => {
    const variant = variants.get(line.variantId);
    if (!variant) throw new InventoryRuleError("INVALID_LINE", "A line refers to a product that is not in this business");
    if (!variant.active) throw new InventoryRuleError("INVALID_LINE", `SKU ${variant.sku} is archived`);
    if (variant.type !== "stocked") throw new InventoryRuleError("INVALID_LINE", `SKU ${variant.sku} is not a stocked item, so it has no stock to adjust`);
    const factor = factors.get(`${line.variantId}|${line.unitId}`);
    if (!factor) throw new InventoryRuleError("INVALID_LINE", `SKU ${variant.sku} is not sold in the chosen unit`);

    const negative = line.quantity.startsWith("-");
    const factorMilli = parseQuantity(factor);
    let baseMilli: number;
    try {
      baseMilli = toBaseQuantity(parseQuantity(line.quantity.replace("-", "")), factorMilli);
    } catch {
      throw new InventoryRuleError("INVALID_LINE", `SKU ${variant.sku}: ${line.quantity} does not convert to a whole number of base units`);
    }
    if (baseMilli <= 0) throw new InventoryRuleError("INVALID_LINE", `SKU ${variant.sku}: the quantity is too small`);

    let costPerBase: Paisa;
    if (negative) {
      const balance = balances.get(line.variantId);
      costPerBase = balance && parseQuantity(balance.onHand) > 0 ? balance.avg : variant.costPaisa;
    } else if (withCost && line.unitCostPaisa !== undefined) {
      // The cost is per entered unit (per carton for cartons); the ledger keeps it per base unit.
      costPerBase = Number(divideRounded(BigInt(line.unitCostPaisa) * 1000n, BigInt(factorMilli)));
    } else {
      costPerBase = variant.costPaisa;
    }
    return {
      variantId: line.variantId,
      unitId: line.unitId,
      qtyEntered: negative ? `-${formatQuantity(parseQuantity(line.quantity.replace("-", "")))}` : formatQuantity(parseQuantity(line.quantity)),
      qtyBaseDelta: formatQuantity(negative ? -baseMilli : baseMilli),
      unitCostPaisa: costPerBase,
      valuePaisa: lineValue(baseMilli, costPerBase),
    };
  });
  return { locationId: input.locationId, lines, totalValuePaisa: lines.reduce((total, line) => total + line.valuePaisa, 0) };
}

export async function getApprovalThreshold(executor: Executor, businessId: string): Promise<Paisa> {
  const [settings] = await executor.select({ threshold: businessSettings.adjustmentApprovalThresholdPaisa }).from(businessSettings)
    .where(eq(businessSettings.businessId, businessId)).limit(1);
  return settings?.threshold ?? 1_000_000;
}

/** Someone who may approve posts their own adjustments straight away; everyone else waits when the value is over the threshold. */
export const needsApproval = (principal: Principal, totalValuePaisa: Paisa, threshold: Paisa) =>
  totalValuePaisa > threshold && !hasPermission(principal, "inventory.approve");

/** Inserts the adjustment and lines, and posts it unless it must wait for approval. Call inside a transaction. */
export async function saveAdjustment(
  tx: Executor,
  principal: Principal,
  adjustment: { reason: typeof stockAdjustments.$inferInsert["reason"]; note: string },
  prepared: PreparedAdjustment,
  post: boolean,
): Promise<string> {
  const actor = getActorId(principal);
  const [created] = await tx.insert(stockAdjustments).values({
    businessId: principal.businessId!,
    locationId: prepared.locationId,
    reason: adjustment.reason,
    note: adjustment.note,
    totalValuePaisa: prepared.totalValuePaisa,
    createdBy: actor,
    updatedBy: actor,
  }).returning({ id: stockAdjustments.id });
  await tx.insert(stockAdjustmentLines).values(prepared.lines.map((line) => ({
    businessId: principal.businessId!,
    adjustmentId: created.id,
    variantId: line.variantId,
    unitId: line.unitId,
    qtyEntered: line.qtyEntered,
    qtyBaseDelta: line.qtyBaseDelta,
    unitCostPaisa: line.unitCostPaisa,
  })));
  if (post) await postAdjustment(tx, principal, created.id);
  return created.id;
}

export async function postAdjustment(tx: Pick<typeof db, "execute">, principal: Principal, adjustmentId: string): Promise<void> {
  await tx.execute(sql`select post_stock_adjustment(${adjustmentId}, ${getActorId(principal)})`);
}

/** Turns the database's deliberate exceptions into answers a person can act on. Returns null for anything else. */
export async function translateStockError(businessId: string, error: unknown): Promise<InventoryRuleError | null> {
  const message = dbErrorMessage(error);
  if (message.includes("ADJUSTMENT_NOT_PENDING")) return new InventoryRuleError("ADJUSTMENT_NOT_PENDING", "This adjustment has already been decided", 409);
  if (message.includes("ADJUSTMENT_NOT_FOUND")) return new InventoryRuleError("NOT_FOUND", "Adjustment not found", 404);
  if (message.includes("STOCK_INSUFFICIENT")) {
    const variantId = /variant ([0-9a-f-]{36}) has ([\d.-]+) on hand/i.exec(message);
    const [variant] = variantId
      ? await db.select({ sku: productVariants.sku }).from(productVariants)
        .where(and(eq(productVariants.id, variantId[1]), eq(productVariants.businessId, businessId))).limit(1)
      : [];
    const onHand = variantId ? formatQuantity(parseQuantity(variantId[2])) : "";
    return new InventoryRuleError("STOCK_INSUFFICIENT", variant ? `Not enough stock of ${variant.sku}: ${onHand} on hand` : "Not enough stock for this adjustment", 409);
  }
  return null;
}

export type AdjustmentView = {
  id: string;
  locationId: string;
  locationName: string;
  reason: string;
  note: string;
  status: "pending" | "approved" | "rejected";
  /** Left out for users without products.cost.view. */
  totalValuePaisa?: Paisa;
  createdAt: Date;
  createdByName: string | null;
  approvedAt: Date | null;
  approvedByName: string | null;
  lines: Array<{ variantId: string; sku: string; productName: string; variantName: string; unitId: string; qtyEntered: string; qtyBaseDelta: string; unitCostPaisa?: Paisa }>;
};

export async function loadAdjustment(businessId: string, id: string, withCost: boolean): Promise<AdjustmentView | null> {
  const [adjustment] = await db.select().from(stockAdjustments).where(and(eq(stockAdjustments.id, id), eq(stockAdjustments.businessId, businessId))).limit(1);
  if (!adjustment) return null;
  const [lines, people, [location]] = await Promise.all([
    db.select({
      variantId: stockAdjustmentLines.variantId, sku: productVariants.sku, productName: products.name, variantName: productVariants.variantName,
      unitId: stockAdjustmentLines.unitId, qtyEntered: stockAdjustmentLines.qtyEntered, qtyBaseDelta: stockAdjustmentLines.qtyBaseDelta, unitCostPaisa: stockAdjustmentLines.unitCostPaisa,
    }).from(stockAdjustmentLines)
      .innerJoin(productVariants, eq(productVariants.id, stockAdjustmentLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(stockAdjustmentLines.adjustmentId, id)).orderBy(productVariants.sku),
    db.select({ id: appUsers.id, name: appUsers.displayName }).from(appUsers)
      .where(and(eq(appUsers.businessId, businessId), inArray(appUsers.id, [adjustment.createdBy, adjustment.approvedBy].filter((value): value is string => Boolean(value))))),
    db.select({ name: locations.name }).from(locations).where(eq(locations.id, adjustment.locationId)).limit(1),
  ]);
  const nameOf = (userId: string | null) => people.find((person) => person.id === userId)?.name ?? null;
  return {
    id: adjustment.id,
    locationId: adjustment.locationId,
    locationName: location?.name ?? "",
    reason: adjustment.reason,
    note: adjustment.note,
    status: adjustment.status,
    ...(withCost ? { totalValuePaisa: adjustment.totalValuePaisa } : {}),
    createdAt: adjustment.createdAt,
    createdByName: nameOf(adjustment.createdBy),
    approvedAt: adjustment.approvedAt,
    approvedByName: nameOf(adjustment.approvedBy),
    lines: lines.map((line) => ({
      variantId: line.variantId, sku: line.sku, productName: line.productName, variantName: line.variantName, unitId: line.unitId,
      qtyEntered: signedQuantityText(line.qtyEntered),
      qtyBaseDelta: signedQuantityText(line.qtyBaseDelta),
      ...(withCost ? { unitCostPaisa: line.unitCostPaisa } : {}),
    })),
  };
}
