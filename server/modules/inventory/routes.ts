import { and, count, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { locations, productUnits, productVariants, products, stockAdjustmentLines, stockAdjustments, stockLedger, appUsers } from "../../../db/schema";
import { lineValue } from "../../../shared/money";
import { rejectAdjustmentSchema, stockAdjustmentSchema } from "../../../shared/schemas/inventory";
import { replayStockLedger } from "../../../shared/stockLedger";
import { formatQuantity, parseSignedQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission, updatedByActor } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { canSeeCost, escapeLike, quantityText } from "../products/service";
import { analyseOpeningFile, commitOpeningStock, OpeningFileError } from "./opening";
import {
  getApprovalThreshold, InventoryRuleError, loadAdjustment, needsApproval, postAdjustment, prepareAdjustment, saveAdjustment,
  signedQuantityText, translateStockError,
} from "./service";

export const inventoryRoutes = new Hono();

const view = requirePermission("inventory.view");
const csvSchema = z.object({ csv: z.string().min(1).max(2_000_000) });
const levelsSchema = z.object({ variantIds: z.array(z.string().uuid()).min(1).max(500), locationId: z.string().uuid().optional() });

const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});
const uuidParam = (value: string | undefined) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined);

/** Runs inventory work and answers rule violations and deliberate database exceptions as 4xx instead of 500. */
async function answering<T>(context: Parameters<typeof apiError>[0], businessId: string, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    const rule = error instanceof InventoryRuleError ? error : await translateStockError(businessId, error);
    if (rule) return apiError(context, rule.status, rule.code, rule.message);
    throw error;
  }
}

// ---------------------------------------------------------------- stock levels

inventoryRoutes.get("/stock", view, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const locationId = uuidParam(context.req.query("locationId"));
  const search = context.req.query("q")?.trim();
  const pattern = search ? `%${escapeLike(search)}%` : null;
  const locationFilter = locationId ? sql`and b.location_id = ${locationId}` : sql``;
  const searchFilter = pattern
    ? sql`and (p.name ilike ${pattern} or v.sku ilike ${pattern}
        or exists (select 1 from product_units pu where pu.variant_id = v.id and pu.barcode ilike ${pattern}))`
    : sql``;
  const lowFilter = context.req.query("low") === "true" ? sql`where reorder_level > 0 and on_hand <= reorder_level` : sql``;

  const rows = await db.execute(sql`
    with levels as (
      select v.id as variant_id, v.sku, v.variant_name, p.id as product_id, p.name as product_name, p.base_unit_id,
             v.reorder_level, v.cost_paisa,
             coalesce(sum(b.on_hand), 0) as on_hand,
             coalesce(sum(b.reserved), 0) as reserved,
             case when coalesce(sum(b.on_hand), 0) > 0
                  then round(sum(b.on_hand * b.avg_cost_paisa) / sum(b.on_hand))::bigint else v.cost_paisa end as avg_cost_paisa,
             round(coalesce(sum(b.on_hand * b.avg_cost_paisa), 0))::bigint as value_paisa
      from product_variants v
      join products p on p.id = v.product_id and p.business_id = v.business_id
      left join stock_balances b on b.variant_id = v.id ${locationFilter}
      where v.business_id = ${businessId} and v.active and p.active and p.product_type = 'stocked' ${searchFilter}
      group by v.id, p.id
    )
    select *, count(*) over () as total from levels ${lowFilter}
    order by product_name, sku limit ${pageSize} offset ${(page - 1) * pageSize}
  `);

  const variantIds = rows.map((row) => String(row.variant_id));
  const unitRows = variantIds.length
    ? await db.select({ variantId: productUnits.variantId, unitId: productUnits.unitId, factor: productUnits.factorToBase, isBase: productUnits.isBase })
      .from(productUnits).where(and(eq(productUnits.businessId, businessId), sql`${productUnits.variantId} in ${variantIds}`))
    : [];
  const withCost = canSeeCost(principal);
  const data = rows.map((row) => {
    const onHand = String(row.on_hand);
    const reserved = String(row.reserved);
    const reorderLevel = String(row.reorder_level);
    return {
      variantId: String(row.variant_id),
      sku: String(row.sku),
      variantName: String(row.variant_name),
      productId: String(row.product_id),
      productName: String(row.product_name),
      baseUnitId: String(row.base_unit_id),
      onHand: quantityText(onHand),
      reserved: quantityText(reserved),
      available: formatQuantity(parseSignedQuantity(onHand) - parseSignedQuantity(reserved)),
      reorderLevel: quantityText(reorderLevel),
      low: parseSignedQuantity(reorderLevel) > 0 && parseSignedQuantity(onHand) <= parseSignedQuantity(reorderLevel),
      units: unitRows.filter((unit) => unit.variantId === row.variant_id).map((unit) => ({ unitId: unit.unitId, factorToBase: quantityText(unit.factor), isBase: unit.isBase })),
      ...(withCost ? { avgCostPaisa: Number(row.avg_cost_paisa), valuePaisa: Number(row.value_paisa) } : {}),
    };
  });
  return context.json({ data, page, pageSize, total: rows.length ? Number(rows[0].total) : 0 });
});

/** Stock for a batch of SKUs in one call, for the POS to refresh what it shows (technical-plan 4.4). */
inventoryRoutes.post("/stock/levels", view, validateJson(levelsSchema), async (context) => {
  const principal = getPrincipal(context);
  const { variantIds, locationId } = context.req.valid("json");
  const rows = await db.execute(sql`
    select v.id as variant_id, coalesce(sum(b.on_hand), 0) as on_hand, coalesce(sum(b.reserved), 0) as reserved
    from product_variants v
    left join stock_balances b on b.variant_id = v.id ${locationId ? sql`and b.location_id = ${locationId}` : sql``}
    where v.business_id = ${principal.businessId!} and v.id in ${variantIds}
    group by v.id
  `);
  return context.json(rows.map((row) => ({
    variantId: String(row.variant_id),
    onHand: quantityText(String(row.on_hand)),
    reserved: quantityText(String(row.reserved)),
    available: formatQuantity(parseSignedQuantity(String(row.on_hand)) - parseSignedQuantity(String(row.reserved))),
  })));
});

// ---------------------------------------------------------------- ledger

inventoryRoutes.get("/stock/ledger", view, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const variantId = uuidParam(context.req.query("variantId"));
  if (!variantId) return apiError(context, 400, "VARIANT_REQUIRED", "Choose a product to see its movements");
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const locationId = uuidParam(context.req.query("locationId"));
  const docType = context.req.query("docType");
  const from = context.req.query("from");
  const to = context.req.query("to");
  for (const [label, value] of [["from", from], ["to", to]] as const) {
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return apiError(context, 400, "INVALID_DATE", `The ${label} date must look like 2026-11-30`);
  }
  // The running balance is computed over every movement of the SKU, then filtered, so it stays correct when filtered.
  const filters = sql`where true
    ${from ? sql`and x.created_at >= (${from}::date)::timestamp at time zone 'Asia/Karachi'` : sql``}
    ${to ? sql`and x.created_at < (${to}::date + 1)::timestamp at time zone 'Asia/Karachi'` : sql``}
    ${docType ? sql`and x.doc_type = ${docType}` : sql``}`;
  const base = sql`
    select l.id, l.seq, l.created_at, l.location_id, l.qty_base, l.unit_cost_paisa, l.doc_type, l.doc_id, l.created_by,
           sum(l.qty_base) over (partition by l.location_id order by l.seq) as balance_after
    from stock_ledger l
    where l.business_id = ${businessId} and l.variant_id = ${variantId} ${locationId ? sql`and l.location_id = ${locationId}` : sql``}`;
  const [rows, totals] = await Promise.all([
    db.execute(sql`
      select x.*, u.display_name as created_by_name, loc.name as location_name
      from (${base}) x
      left join users u on u.id = x.created_by
      left join locations loc on loc.id = x.location_id
      ${filters}
      order by x.seq desc limit ${pageSize} offset ${(page - 1) * pageSize}`),
    db.execute(sql`select count(*) as total from (${base}) x ${filters}`),
  ]);
  const withCost = canSeeCost(principal);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id),
      createdAt: row.created_at,
      locationId: String(row.location_id),
      locationName: String(row.location_name ?? ""),
      quantity: signedQuantityText(String(row.qty_base)),
      balanceAfter: signedQuantityText(String(row.balance_after)),
      docType: String(row.doc_type),
      docId: String(row.doc_id),
      createdByName: row.created_by_name ? String(row.created_by_name) : null,
      ...(withCost ? { unitCostPaisa: Number(row.unit_cost_paisa) } : {}),
    })),
    page,
    pageSize,
    total: Number(totals[0].total),
  });
});

// ---------------------------------------------------------------- valuation

inventoryRoutes.get("/stock/valuation", requirePermission("products.cost.view"), view, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const asOf = context.req.query("asOf");
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return apiError(context, 400, "INVALID_DATE", "The date must look like 2026-11-30");
  const locationId = uuidParam(context.req.query("locationId"));

  // Replay the ledger up to the end of the chosen day (Asia/Karachi), in posting order.
  const entries = await db.select({
    variantId: stockLedger.variantId, locationId: stockLedger.locationId, qty: stockLedger.qtyBase, cost: stockLedger.unitCostPaisa,
  }).from(stockLedger).where(and(
    eq(stockLedger.businessId, businessId),
    locationId ? eq(stockLedger.locationId, locationId) : undefined,
    asOf ? sql`${stockLedger.createdAt} < (${asOf}::date + 1)::timestamp at time zone 'Asia/Karachi'` : undefined,
  )).orderBy(stockLedger.seq);
  const positions = replayStockLedger(entries.map((entry) => ({ variantId: entry.variantId, locationId: entry.locationId, qtyMilli: parseSignedQuantity(entry.qty), unitCostPaisa: entry.cost })));

  const perVariant = new Map<string, { onHandMilli: number; costValue: number }>();
  for (const [key, position] of positions) {
    if (position.onHandMilli === 0) continue;
    const variantId = key.split("|")[0];
    const current = perVariant.get(variantId) ?? { onHandMilli: 0, costValue: 0 };
    current.onHandMilli += position.onHandMilli;
    current.costValue += lineValue(position.onHandMilli, position.avgCostPaisa);
    perVariant.set(variantId, current);
  }
  const variantIds = [...perVariant.keys()];
  const details = variantIds.length
    ? await db.select({
      id: productVariants.id, sku: productVariants.sku, variantName: productVariants.variantName, productName: products.name, baseUnitId: products.baseUnitId, price: productUnits.salePricePaisa,
    }).from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(productUnits, and(eq(productUnits.variantId, productVariants.id), eq(productUnits.isBase, true)))
      .where(and(eq(productVariants.businessId, businessId), sql`${productVariants.id} in ${variantIds}`))
    : [];
  const rows = details.map((detail) => {
    const stock = perVariant.get(detail.id)!;
    return {
      variantId: detail.id,
      sku: detail.sku,
      productName: detail.productName,
      variantName: detail.variantName,
      baseUnitId: detail.baseUnitId,
      onHand: formatQuantity(stock.onHandMilli),
      costValuePaisa: stock.costValue,
      salePricePaisa: detail.price ?? 0,
      saleValuePaisa: lineValue(stock.onHandMilli, detail.price ?? 0),
    };
  }).sort((a, b) => a.productName.localeCompare(b.productName) || a.sku.localeCompare(b.sku));
  return context.json({
    asOf: asOf ?? null,
    // Sale prices are not versioned yet (FR-PRD-13), so sale value always uses today's price.
    salePriceBasis: "current",
    rows,
    totals: {
      costValuePaisa: rows.reduce((total, row) => total + row.costValuePaisa, 0),
      saleValuePaisa: rows.reduce((total, row) => total + row.saleValuePaisa, 0),
    },
  });
});

// ---------------------------------------------------------------- adjustments

inventoryRoutes.get("/stock-adjustments", view, async (context) => {
  const principal = getPrincipal(context);
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const status = context.req.query("status");
  const conditions = and(
    eq(stockAdjustments.businessId, principal.businessId!),
    status === "pending" || status === "approved" || status === "rejected" ? eq(stockAdjustments.status, status) : undefined,
  );
  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: stockAdjustments.id, reason: stockAdjustments.reason, status: stockAdjustments.status, note: stockAdjustments.note,
      totalValuePaisa: stockAdjustments.totalValuePaisa, createdAt: stockAdjustments.createdAt, locationName: locations.name, createdByName: appUsers.displayName,
      lineCount: sql<number>`(select count(*)::int from ${stockAdjustmentLines} where ${stockAdjustmentLines.adjustmentId} = ${stockAdjustments.id})`,
    }).from(stockAdjustments)
      .innerJoin(locations, eq(locations.id, stockAdjustments.locationId))
      .leftJoin(appUsers, eq(appUsers.id, stockAdjustments.createdBy))
      .where(conditions).orderBy(desc(stockAdjustments.createdAt), desc(stockAdjustments.id)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ total: count() }).from(stockAdjustments).where(conditions),
  ]);
  const withCost = canSeeCost(principal);
  return context.json({ data: rows.map(({ totalValuePaisa, ...row }) => ({ ...row, ...(withCost ? { totalValuePaisa } : {}) })), page, pageSize, total });
});

inventoryRoutes.get("/stock-adjustments/:id", view, async (context) => {
  const principal = getPrincipal(context);
  const adjustment = await loadAdjustment(principal.businessId!, paramId(context), canSeeCost(principal));
  return adjustment ? context.json(adjustment) : apiError(context, 404, "NOT_FOUND", "Adjustment not found");
});

inventoryRoutes.post("/stock-adjustments", requirePermission("inventory.adjust"), idempotent(), validateJson(stockAdjustmentSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  const outcome = await answering(context, businessId, async () => {
    const prepared = await prepareAdjustment(db, principal, input);
    const pending = needsApproval(principal, prepared.totalValuePaisa, await getApprovalThreshold(db, businessId));
    const id = await db.transaction((tx) => saveAdjustment(tx, principal, { reason: input.reason, note: input.note }, prepared, !pending));
    return { id, pending };
  });
  if (outcome instanceof Response) return outcome;
  await auditPrincipal(context, principal, "stock_adjustment", outcome.id, "create", null, { reason: input.reason, status: outcome.pending ? "pending" : "approved", lines: input.lines.length });
  return context.json(await loadAdjustment(businessId, outcome.id, canSeeCost(principal)), 201);
});

inventoryRoutes.post("/stock-adjustments/:id/approve", requirePermission("inventory.approve"), idempotent(), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  const outcome = await answering(context, businessId, async () => {
    const [current] = await db.select({ status: stockAdjustments.status }).from(stockAdjustments)
      .where(and(eq(stockAdjustments.id, id), eq(stockAdjustments.businessId, businessId))).limit(1);
    if (!current) throw new InventoryRuleError("NOT_FOUND", "Adjustment not found", 404);
    if (current.status !== "pending") throw new InventoryRuleError("ADJUSTMENT_NOT_PENDING", `This adjustment was already ${current.status}`, 409);
    await db.transaction((tx) => postAdjustment(tx, principal, id));
    return true;
  });
  if (outcome instanceof Response) return outcome;
  await auditPrincipal(context, principal, "stock_adjustment", id, "approve", { status: "pending" }, { status: "approved" });
  return context.json(await loadAdjustment(businessId, id, canSeeCost(principal)));
});

inventoryRoutes.post("/stock-adjustments/:id/reject", requirePermission("inventory.approve"), validateJson(rejectAdjustmentSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  const { reason } = context.req.valid("json");
  const [current] = await db.select().from(stockAdjustments).where(and(eq(stockAdjustments.id, id), eq(stockAdjustments.businessId, businessId))).limit(1);
  if (!current) return apiError(context, 404, "NOT_FOUND", "Adjustment not found");
  if (current.status !== "pending") return apiError(context, 409, "ADJUSTMENT_NOT_PENDING", `This adjustment was already ${current.status}`);
  const rejected = await db.update(stockAdjustments).set({
    status: "rejected", approvedBy: getActorId(principal), approvedAt: new Date(), note: `${current.note}\nRejected: ${reason}`.trim(), ...updatedByActor(principal),
  }).where(and(eq(stockAdjustments.id, id), eq(stockAdjustments.status, "pending"))).returning({ id: stockAdjustments.id });
  if (!rejected.length) return apiError(context, 409, "ADJUSTMENT_NOT_PENDING", "This adjustment was just decided by someone else");
  await auditPrincipal(context, principal, "stock_adjustment", id, "reject", { status: "pending" }, { status: "rejected", reason });
  return context.json(await loadAdjustment(businessId, id, canSeeCost(principal)));
});

// ---------------------------------------------------------------- opening stock

inventoryRoutes.post("/stock/opening/preview", requirePermission("inventory.opening_stock"), validateJson(csvSchema), async (context) => {
  const principal = getPrincipal(context);
  try {
    const analysis = await analyseOpeningFile(db, principal, context.req.valid("json").csv);
    return context.json({
      canImport: analysis.issues.length === 0,
      issues: analysis.issues,
      summary: { lines: analysis.lineCount, locations: analysis.byLocation.size },
    });
  } catch (error) {
    if (error instanceof OpeningFileError) return apiError(context, 400, "INVALID_CSV", error.message);
    throw error;
  }
});

inventoryRoutes.post("/stock/opening", requirePermission("inventory.opening_stock"), idempotent(), validateJson(csvSchema), async (context) => {
  const principal = getPrincipal(context);
  try {
    const outcome = await db.transaction(async (tx) => {
      const analysis = await analyseOpeningFile(tx, principal, context.req.valid("json").csv);
      if (analysis.issues.length) return { issues: analysis.issues };
      return { result: await commitOpeningStock(tx, principal, analysis) };
    });
    if ("issues" in outcome) {
      return context.json({ error: { code: "IMPORT_HAS_ERRORS", message: "Fix the listed rows and import again", details: outcome.issues } }, 422);
    }
    await auditPrincipal(context, principal, "stock_adjustment", "opening", "opening_stock", null, { lines: outcome.result.lines, locations: outcome.result.locations });
    return context.json(outcome.result, 201);
  } catch (error) {
    if (error instanceof OpeningFileError) return apiError(context, 400, "INVALID_CSV", error.message);
    throw error;
  }
});
