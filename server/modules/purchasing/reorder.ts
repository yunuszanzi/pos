import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { reorderDraftSchema } from "../../../shared/schemas/purchasing";
import { suggestReorder } from "../../../shared/purchasing";
import { formatQuantity, parseQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { canSeeCost, escapeLike } from "../products/service";
import { factsFor, mapFunctionError, payloadLine } from "./routes";

// What to reorder (FR-INV-08, FR-PUR-07) and what was paid last time (FR-PUR-08).

export const reorderRoutes = new Hono();

const view = requirePermission("purchasing.view");
const order = requirePermission("purchasing.order");
const costs = requirePermission("products.cost.view");
const paisa = (value: unknown) => Number(value);
const quantityText = (value: unknown) => formatQuantity(parseQuantity(String(value)));
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

/**
 * What a bill or receipt last charged for each SKU, in whole paisa per base unit: the billed price when the goods were billed, else the
 * receipt's. One row per variant, the most recent receipt.
 */
async function lastCosts(businessId: string, variantIds: string[]) {
  if (!variantIds.length) return new Map<string, number>();
  const rows = await db.execute<{ variant_id: string; cost: string }>(sql`
    select distinct on (rl.variant_id) rl.variant_id, round(coalesce(bl.unit_cost_paisa, rl.unit_cost_paisa) / rl.factor_to_base)::bigint as cost
    from goods_receipt_lines rl join goods_receipts r on r.id = rl.receipt_id
    left join lateral (
      select l.unit_cost_paisa from purchase_bill_lines l join purchase_bills b on b.id = l.bill_id where l.receipt_line_id = rl.id order by b.created_at desc, b.number desc limit 1
    ) bl on true
    where rl.business_id = ${businessId} and rl.variant_id in (${sql.join(variantIds.map((id) => sql`${id}::uuid`), sql`, `)})
    order by rl.variant_id, r.received_at desc, rl.line_no`);
  return new Map(rows.map((row) => [row.variant_id, paisa(row.cost)]));
}

/**
 * SKUs that need ordering: those whose stock (on hand plus ordered and still to come) is at or below their reorder level, most
 * short first. Each comes with the supplier it is normally bought from (the one set, else the last it was received from) and
 * what it last cost. Paginated; `locationId` counts the stock of one location only.
 */
reorderRoutes.get("/reorder-list", view, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const page = Math.max(1, Math.trunc(Number(context.req.query("page") ?? 1)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(context.req.query("pageSize") ?? 25)) || 25));
  const locationId = context.req.query("locationId");
  const search = context.req.query("q")?.trim();
  const where = locationId && /^[0-9a-f-]{36}$/i.test(locationId) ? sql`and location_id = ${locationId}` : sql``;
  const named = search ? sql`and (p.name ilike ${`%${escapeLike(search)}%`} or v.sku ilike ${`%${escapeLike(search)}%`})` : sql``;
  const rows = await db.execute(sql`
    with held as (select variant_id, sum(on_hand) as qty from stock_balances where business_id = ${businessId} ${where} group by variant_id),
         ordered as (
           select ol.variant_id, sum(ol.qty_base - ol.received_base) as qty from purchase_order_lines ol join purchase_orders o on o.id = ol.order_id
           where o.business_id = ${businessId} and o.status in ('sent', 'partly_received') group by ol.variant_id
         )
    select v.id as variant_id, v.sku, v.variant_name, p.name as product_name, p.base_unit_id, u.name as base_unit_name, v.reorder_level, v.reorder_quantity,
           coalesce(h.qty, 0) as on_hand, coalesce(o.qty, 0) as on_order,
           ps.supplier_id as preferred_id, pss.name as preferred_name, ls.supplier_id as last_id, ls.name as last_name, count(*) over () as total
    from product_variants v
    join products p on p.id = v.product_id and p.active and p.product_type = 'stocked'
    join units u on u.id = p.base_unit_id
    left join held h on h.variant_id = v.id
    left join ordered o on o.variant_id = v.id
    left join preferred_suppliers ps on ps.variant_id = v.id
    left join suppliers pss on pss.id = ps.supplier_id
    left join lateral (
      select r.supplier_id, s.name from goods_receipt_lines rl join goods_receipts r on r.id = rl.receipt_id join suppliers s on s.id = r.supplier_id
      where rl.variant_id = v.id order by r.received_at desc limit 1
    ) ls on true
    where v.business_id = ${businessId} and v.active and v.reorder_level > 0 and coalesce(h.qty, 0) + coalesce(o.qty, 0) <= v.reorder_level ${named}
    order by (coalesce(h.qty, 0) + coalesce(o.qty, 0)) - v.reorder_level, p.name, v.sku
    limit ${pageSize} offset ${(page - 1) * pageSize}`);
  const withCost = canSeeCost(principal);
  const costs = withCost ? await lastCosts(businessId, rows.map((row) => String(row.variant_id))) : new Map<string, number>();
  return context.json({
    data: rows.map((row) => {
      const suggested = suggestReorder({
        onHandMilli: parseQuantity(String(row.on_hand)), onOrderMilli: parseQuantity(String(row.on_order)),
        levelMilli: parseQuantity(String(row.reorder_level)), reorderQuantityMilli: parseQuantity(String(row.reorder_quantity)),
      });
      const supplier = row.preferred_id ? { id: String(row.preferred_id), name: String(row.preferred_name), preferred: true }
        : row.last_id ? { id: String(row.last_id), name: String(row.last_name), preferred: false } : null;
      return {
        variantId: String(row.variant_id), sku: String(row.sku), productName: String(row.product_name), variantName: String(row.variant_name),
        baseUnitName: String(row.base_unit_name), onHand: quantityText(row.on_hand), onOrder: quantityText(row.on_order), reorderLevel: quantityText(row.reorder_level),
        suggestedQuantity: suggested === null ? "0" : formatQuantity(suggested), supplier,
        ...(withCost && costs.has(String(row.variant_id)) ? { lastCostPerBasePaisa: costs.get(String(row.variant_id)) } : {}),
      };
    }),
    page, pageSize, total: rows.length ? paisa(rows[0].total) : 0,
  });
});

/**
 * Turns chosen reorder lines into draft purchase orders, one per supplier, each line in the SKU's base unit at what it last cost (the
 * SKU's cost when it has never been bought). Drafts are changed and sent from the orders page. A line may also set its supplier as the
 * one the SKU is normally bought from. All of it happens together or not at all.
 */
reorderRoutes.post("/reorder-list/draft-orders", order, costs, idempotent(), validateJson(reorderDraftSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  const variantIds = [...new Set(input.lines.map((line) => line.variantId))];
  if (variantIds.length !== input.lines.length) return apiError(context, 422, "INVALID_LINE", "A SKU can be on the reorder only once");

  const bases = await db.execute<{ variant_id: string; unit_id: string; cost_paisa: string }>(sql`
    select pu.variant_id, pu.unit_id, v.cost_paisa from product_units pu join product_variants v on v.id = pu.variant_id
    where pu.business_id = ${businessId} and pu.is_base and pu.variant_id in (${sql.join(variantIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  const baseOf = new Map(bases.map((row) => [row.variant_id, row]));
  const facts = await factsFor(businessId, bases.map((row) => ({ variantId: row.variant_id, unitId: row.unit_id })));
  const bought = await lastCosts(businessId, variantIds);

  const bySupplier = new Map<string, typeof input.lines>();
  for (const line of input.lines) bySupplier.set(line.supplierId, [...(bySupplier.get(line.supplierId) ?? []), line]);

  const created: Array<{ id: string; number: string; supplierName: string; lineCount: number; totalPaisa: number }> = [];
  try {
    await db.transaction(async (tx) => {
      for (const [supplierId, lines] of bySupplier) {
        const payloadLines = [];
        for (const line of lines) {
          const base = baseOf.get(line.variantId);
          const fact = base ? facts.get(`${base.variant_id}|${base.unit_id}`) : undefined;
          if (!base || !fact) throw new Error("INVALID_LINE: a line is not an active stocked product");
          payloadLines.push(payloadLine(fact, line.quantity, bought.get(line.variantId) ?? paisa(base.cost_paisa)));
        }
        const payload = { business_id: businessId, supplier_id: supplierId, location_id: input.locationId, note: "From the reorder list", lines: payloadLines };
        const [row] = await tx.execute<{ id: string }>(sql`select save_purchase_order(${JSON.stringify(payload)}::jsonb, ${getActorId(principal)}) as id`);
        const [saved] = await tx.execute<{ number: string; supplier_name: string; total_paisa: string }>(sql`
          select o.number, s.name as supplier_name, o.total_paisa from purchase_orders o join suppliers s on s.id = o.supplier_id where o.id = ${row.id}`);
        created.push({ id: row.id, number: saved.number, supplierName: saved.supplier_name, lineCount: lines.length, totalPaisa: paisa(saved.total_paisa) });
        for (const line of lines.filter((entry) => entry.remember)) {
          await tx.execute(sql`
            insert into preferred_suppliers (business_id, variant_id, supplier_id, updated_by) values (${businessId}, ${line.variantId}, ${supplierId}, ${getActorId(principal)})
            on conflict (variant_id) do update set supplier_id = excluded.supplier_id, updated_at = now(), updated_by = excluded.updated_by`);
        }
      }
    });
  } catch (error) {
    const mapped = mapFunctionError(context, error);
    if (mapped) return mapped;
    if (error instanceof Error && error.message.startsWith("INVALID_LINE")) return apiError(context, 422, "INVALID_LINE", error.message.replace(/^[A-Z_]+:\s*/, ""));
    throw error;
  }
  for (const draft of created) await auditPrincipal(context, principal, "purchase_order", draft.id, "create", null, { from: "reorder list", lines: draft.lineCount });
  return context.json({ orders: created }, 201);
});

/**
 * What a SKU was bought for before (FR-PUR-08): the last few receipts with the price each carried (the billed price when billed),
 * newest first, and the last cost per base unit. For the purchase order screen to suggest a price and show the history.
 */
reorderRoutes.get("/purchase-history/:variantId", view, costs, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const variantId = paramId(context, "variantId");
  const rows = await db.execute(sql`
    select r.number, r.received_at, s.name as supplier_name, rl.unit_name, rl.factor_to_base,
           coalesce(bl.unit_cost_paisa, rl.unit_cost_paisa) as unit_cost, (bl.unit_cost_paisa is not null) as billed,
           round(coalesce(bl.unit_cost_paisa, rl.unit_cost_paisa) / rl.factor_to_base)::bigint as cost_per_base
    from goods_receipt_lines rl join goods_receipts r on r.id = rl.receipt_id join suppliers s on s.id = r.supplier_id
    left join lateral (
      select l.unit_cost_paisa from purchase_bill_lines l join purchase_bills b on b.id = l.bill_id where l.receipt_line_id = rl.id order by b.created_at desc, b.number desc limit 1
    ) bl on true
    where rl.business_id = ${businessId} and rl.variant_id = ${variantId}
    order by r.received_at desc, rl.line_no limit 5`);
  return context.json({
    lastCostPerBasePaisa: rows.length ? paisa(rows[0].cost_per_base) : null,
    entries: rows.map((row) => ({
      receiptNumber: String(row.number), receivedAt: iso(row.received_at), supplierName: String(row.supplier_name), unitName: String(row.unit_name),
      factorToBase: quantityText(row.factor_to_base), unitCostPaisa: paisa(row.unit_cost), billed: Boolean(row.billed), costPerBasePaisa: paisa(row.cost_per_base),
    })),
  });
});
