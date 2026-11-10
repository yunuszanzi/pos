import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { addCountItemsSchema, countEntriesSchema, countNoteSchema, scanCountSchema, startStockCountSchema, stockCountStatuses } from "../../../shared/schemas/stockCounts";
import { formatQuantity, parseQuantity, parseSignedQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { canSeeCost, escapeLike } from "../products/service";
import { signedQuantityText } from "./service";

// Physical stock counts (FR-INV-05). The books' figure is frozen when a count starts; people count; the variance is reviewed and,
// on approval, posted as one stock adjustment.

export const countRoutes = new Hono();

const view = requirePermission("inventory.view");
const count = requirePermission("inventory.count");
const approve = requirePermission("inventory.approve");
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const qty = (value: unknown) => signedQuantityText(String(value));
const pageOf = (query: (name: string) => string | undefined, defaultSize = 25, max = 100) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(max, Math.max(1, Math.trunc(Number(query("pageSize") ?? defaultSize)) || defaultSize)),
});

const functionErrors: Array<[prefix: string, status: 404 | 409 | 422, code: string]> = [
  ["NOT_FOUND", 404, "NOT_FOUND"],
  ["INVALID_LINE", 422, "INVALID_LINE"],
  ["LOCATION_INACTIVE", 409, "LOCATION_INACTIVE"],
  ["COUNT_ALREADY_OPEN", 409, "COUNT_ALREADY_OPEN"],
  ["COUNT_NOT_OPEN", 409, "COUNT_NOT_OPEN"],
  ["NOTHING_COUNTED", 409, "NOTHING_COUNTED"],
  ["INVALID_TRANSITION", 409, "INVALID_TRANSITION"],
];

async function failed(context: Context, businessId: string, error: unknown): Promise<Response | null> {
  const message = dbErrorMessage(error);
  if (message.includes("STOCK_INSUFFICIENT")) {
    const found = /variant ([0-9a-f-]{36}) has (-?[\d.]+) on hand/i.exec(message);
    const [row] = found ? await db.execute<{ name: string; sku: string }>(sql`select p.name, v.sku from product_variants v join products p on p.id = v.product_id where v.id = ${found[1]} and v.business_id = ${businessId}`) : [];
    return apiError(context, 409, "STOCK_INSUFFICIENT", `The count would take ${row ? `${row.name} (${row.sku})` : "an item"} below zero${found ? `: ${qty(found[2])} on hand now` : ""}. Stock has moved since the count started; send the count back and count that item again.`);
  }
  if (message.includes("stock_counts_one_open_uidx")) return apiError(context, 409, "COUNT_ALREADY_OPEN", "This location already has a count that is not finished");
  const known = functionErrors.find(([prefix]) => message.includes(prefix));
  return known ? apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message) : null;
}

type Filter = "all" | "uncounted" | "differences";

/** One count: the header, the totals over every line, and a page of lines (a full count can have thousands). */
async function loadCount(businessId: string, id: string, withCost: boolean, options: { filter?: Filter; q?: string; page?: number; pageSize?: number } = {}) {
  const [row] = await db.execute(sql`
    select c.*, l.name as location_name, sb.display_name as submitted_by_name, ab.display_name as approved_by_name, cb.display_name as created_by_name, a.status as adjustment_status
    from stock_counts c join locations l on l.id = c.location_id
    left join users sb on sb.id = c.submitted_by left join users ab on ab.id = c.approved_by left join users cb on cb.id = c.created_by
    left join stock_adjustments a on a.id = c.adjustment_id
    where c.business_id = ${businessId} and c.id = ${id}`);
  if (!row) return null;
  const [totals] = await db.execute(sql`
    select count(*)::int as items, count(counted_base)::int as counted,
           count(*) filter (where counted_base is not null and counted_base <> expected_base)::int as differences,
           coalesce(sum(case when counted_base > expected_base then counted_base - expected_base else 0 end), 0) as over_units,
           coalesce(sum(case when counted_base < expected_base then expected_base - counted_base else 0 end), 0) as short_units,
           coalesce(sum((counted_base - expected_base) * cost_paisa) filter (where counted_base is not null), 0) as net_value,
           coalesce(sum(case when counted_base > expected_base then (counted_base - expected_base) * cost_paisa else 0 end), 0) as over_value,
           coalesce(sum(case when counted_base < expected_base then (expected_base - counted_base) * cost_paisa else 0 end), 0) as short_value
    from stock_count_lines where business_id = ${businessId} and count_id = ${id}`);
  const filters = [sql`l.business_id = ${businessId}`, sql`l.count_id = ${id}`];
  if (options.filter === "uncounted") filters.push(sql`l.counted_base is null`);
  if (options.filter === "differences") filters.push(sql`l.counted_base is not null and l.counted_base <> l.expected_base`);
  if (options.q) {
    const pattern = `%${escapeLike(options.q)}%`;
    filters.push(sql`(l.sku ilike ${pattern} or l.product_name ilike ${pattern} or exists (select 1 from product_units pu where pu.variant_id = l.variant_id and pu.barcode ilike ${pattern}))`);
  }
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 100;
  const lines = await db.execute(sql`
    select l.*, u.name as base_unit_name, coalesce(b.on_hand, 0) as on_hand_now, count(*) over () as total
    from stock_count_lines l join product_variants v on v.id = l.variant_id join products p on p.id = v.product_id join units u on u.id = p.base_unit_id
    left join stock_balances b on b.variant_id = l.variant_id and b.location_id = ${String(row.location_id)}
    where ${sql.join(filters, sql` and `)}
    order by (l.counted_base is null), l.product_name, l.sku limit ${pageSize} offset ${(page - 1) * pageSize}`);
  const money = (value: unknown) => Math.round(Number(value));
  return {
    id: String(row.id), number: String(row.number), status: String(row.status), scope: String(row.scope), locationId: String(row.location_id), locationName: String(row.location_name),
    note: String(row.note), reviewNote: String(row.review_note), adjustmentId: row.adjustment_id ? String(row.adjustment_id) : null,
    startedAt: iso(row.started_at), createdByName: row.created_by_name ? String(row.created_by_name) : null,
    submittedAt: iso(row.submitted_at), submittedByName: row.submitted_by_name ? String(row.submitted_by_name) : null,
    approvedAt: iso(row.approved_at), approvedByName: row.approved_by_name ? String(row.approved_by_name) : null, cancelledAt: iso(row.cancelled_at),
    summary: {
      items: Number(totals.items), counted: Number(totals.counted), uncounted: Number(totals.items) - Number(totals.counted), differences: Number(totals.differences),
      overUnits: qty(totals.over_units), shortUnits: qty(totals.short_units),
      ...(withCost ? { netValuePaisa: money(totals.net_value), overValuePaisa: money(totals.over_value), shortValuePaisa: money(totals.short_value) } : {}),
    },
    lines: {
      page, pageSize, total: lines.length ? Number(lines[0].total) : 0,
      data: lines.map((line) => {
        const expected = String(line.expected_base);
        const counted = line.counted_base === null ? null : String(line.counted_base);
        const variance = counted === null ? null : parseSignedQuantity(counted) - parseSignedQuantity(expected);
        return {
          variantId: String(line.variant_id), sku: String(line.sku), productName: String(line.product_name), variantName: String(line.variant_name), unitName: String(line.base_unit_name),
          expectedBase: qty(expected), countedBase: counted === null ? null : qty(counted),
          varianceBase: variance === null ? null : signedQuantityText(formatSigned(variance)),
          // What the stock has done since the freeze (sales, receipts, transfers): the count is measured against the frozen figure.
          movedSinceBase: signedQuantityText(formatSigned(parseSignedQuantity(String(line.on_hand_now)) - parseSignedQuantity(expected))),
          ...(withCost ? { costPaisa: Number(line.cost_paisa), varianceValuePaisa: variance === null ? null : Math.round((variance * Number(line.cost_paisa)) / 1000) } : {}),
        };
      }),
    },
  };
}

/** Thousandths back to text with a sign, for quantities that can be negative. */
function formatSigned(milli: number): string {
  return `${milli < 0 ? "-" : ""}${formatQuantity(Math.abs(milli))}`;
}

countRoutes.get("/stock-counts", view, async (context) => {
  const principal = getPrincipal(context);
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const status = context.req.query("status") ?? "";
  const filters = [sql`c.business_id = ${principal.businessId!}`];
  if ((stockCountStatuses as readonly string[]).includes(status)) filters.push(sql`c.status = ${status}`);
  if (status === "open") filters.push(sql`c.status in ('counting', 'submitted')`);
  const rows = await db.execute(sql`
    select c.id, c.number, c.status, c.scope, c.started_at, c.approved_at, l.name as location_name,
           (select count(*) from stock_count_lines x where x.count_id = c.id)::int as items,
           (select count(*) from stock_count_lines x where x.count_id = c.id and x.counted_base is not null)::int as counted,
           count(*) over () as total
    from stock_counts c join locations l on l.id = c.location_id where ${sql.join(filters, sql` and `)}
    order by c.started_at desc, c.number desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id), number: String(row.number), status: String(row.status), scope: String(row.scope), locationName: String(row.location_name),
      items: Number(row.items), counted: Number(row.counted), startedAt: iso(row.started_at), approvedAt: iso(row.approved_at),
    })),
    page, pageSize, total: rows.length ? Number(rows[0].total) : 0,
  });
});

countRoutes.get("/stock-counts/:id", view, async (context) => {
  const principal = getPrincipal(context);
  const filter = context.req.query("filter");
  const { page, pageSize } = pageOf((name) => context.req.query(name), 100, 200);
  const found = await loadCount(principal.businessId!, paramId(context), canSeeCost(principal), {
    filter: filter === "uncounted" || filter === "differences" ? filter : "all", q: context.req.query("q")?.trim().slice(0, 100) || undefined, page, pageSize,
  });
  return found ? context.json(found) : apiError(context, 404, "NOT_FOUND", "Stock count not found");
});

countRoutes.post("/stock-counts", count, idempotent(), validateJson(startStockCountSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select start_stock_count(${JSON.stringify({
        business_id: businessId, location_id: input.locationId, scope: input.scope, variant_ids: input.variantIds, note: input.note,
      })}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return response;
    throw error;
  }
  await auditPrincipal(context, principal, "stock_count", id, "start", null, { locationId: input.locationId, scope: input.scope });
  return context.json(await loadCount(businessId, id, canSeeCost(principal)), 201);
});

/** Counts typed in. An item that is not in the count yet is added to it (something found on the shelf that was not expected). */
countRoutes.post("/stock-counts/:id/entries", count, validateJson(countEntriesSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  const input = context.req.valid("json");
  try {
    await db.transaction(async (tx) => {
      const [header] = await tx.execute<{ status: string }>(sql`select status from stock_counts where id = ${id} and business_id = ${businessId} for update`);
      if (!header) throw new Error("NOT_FOUND: no such stock count");
      if (header.status !== "counting") throw new Error(`COUNT_NOT_OPEN: the count is ${header.status}, so it cannot be counted`);
      const variantIds = [...new Set(input.entries.map((entry) => entry.variantId))];
      await tx.execute(sql`select add_stock_count_items(${businessId}::uuid, ${id}::uuid, ${sql.raw(`ARRAY[${variantIds.map((variant) => `'${variant}'`).join(",")}]::uuid[]`)})`);
      for (const entry of input.entries) {
        const [unit] = await tx.execute<{ factor_to_base: string }>(sql`select factor_to_base from product_units where business_id = ${businessId} and variant_id = ${entry.variantId} and unit_id = ${entry.unitId}`);
        if (!unit) throw new Error("INVALID_LINE: the item is not sold in that unit");
        const counted = formatQuantity(Math.round(parseQuantity(entry.quantity) * parseQuantity(unit.factor_to_base) / 1000));
        await tx.execute(sql`
          update stock_count_lines set counted_base = ${input.mode === "add" ? sql`coalesce(counted_base, 0) + ${counted}::numeric` : sql`${counted}::numeric`},
            counted_at = now(), counted_by = ${getActorId(principal)}
          where count_id = ${id} and variant_id = ${entry.variantId}`);
      }
    });
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return response;
    throw error;
  }
  return context.json(await loadCount(businessId, id, canSeeCost(principal), { page: 1, pageSize: 100 }));
});

/** A barcode scan: finds the item, adds it to the count if it was not there, and counts one more of the unit the barcode stands for. */
countRoutes.post("/stock-counts/:id/scan", count, validateJson(scanCountSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  const input = context.req.valid("json");
  const [unit] = await db.execute<{ variant_id: string; factor_to_base: string; sku: string; product_name: string; type: string; active: boolean }>(sql`
    select pu.variant_id, pu.factor_to_base, v.sku, p.name as product_name, p.product_type as type, v.active
    from product_units pu join product_variants v on v.id = pu.variant_id join products p on p.id = v.product_id
    where pu.business_id = ${businessId} and (pu.barcode = ${input.code} or v.sku = ${input.code}) limit 1`);
  if (!unit || !unit.active) return apiError(context, 404, "NOT_FOUND", `No product has the barcode or SKU ${input.code}`);
  if (unit.type !== "stocked") return apiError(context, 422, "INVALID_LINE", `${unit.product_name} is not a stocked item, so it is not counted`);
  const added = formatQuantity(Math.round(parseQuantity(input.quantity) * parseQuantity(unit.factor_to_base) / 1000));
  try {
    await db.transaction(async (tx) => {
      const [header] = await tx.execute<{ status: string }>(sql`select status from stock_counts where id = ${id} and business_id = ${businessId} for update`);
      if (!header) throw new Error("NOT_FOUND: no such stock count");
      if (header.status !== "counting") throw new Error(`COUNT_NOT_OPEN: the count is ${header.status}, so it cannot be counted`);
      await tx.execute(sql`select add_stock_count_items(${businessId}::uuid, ${id}::uuid, ARRAY[${unit.variant_id}]::uuid[])`);
      await tx.execute(sql`update stock_count_lines set counted_base = coalesce(counted_base, 0) + ${added}::numeric, counted_at = now(), counted_by = ${getActorId(principal)} where count_id = ${id} and variant_id = ${unit.variant_id}`);
    });
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return response;
    throw error;
  }
  const [line] = await db.execute<{ counted_base: string; expected_base: string }>(sql`select counted_base, expected_base from stock_count_lines where count_id = ${id} and variant_id = ${unit.variant_id}`);
  return context.json({ variantId: unit.variant_id, sku: unit.sku, productName: unit.product_name, countedBase: qty(line.counted_base), expectedBase: qty(line.expected_base) });
});

countRoutes.post("/stock-counts/:id/items", count, validateJson(addCountItemsSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select add_stock_count_items(${businessId}::uuid, ${id}::uuid, ${sql.raw(`ARRAY[${context.req.valid("json").variantIds.map((variant) => `'${variant}'`).join(",")}]::uuid[]`)})`);
    });
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return response;
    throw error;
  }
  return context.json(await loadCount(businessId, id, canSeeCost(principal), { page: 1, pageSize: 100 }));
});

async function moveCount(context: Context, action: "submit" | "reopen" | "cancel", status: "submitted" | "counting" | "cancelled", note = "") {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_stock_count_status(${businessId}::uuid, ${id}::uuid, ${status}, ${note}, ${getActorId(principal)})`);
    });
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return response;
    throw error;
  }
  await auditPrincipal(context, principal, "stock_count", id, action, null, { status, note });
  return context.json(await loadCount(businessId, id, canSeeCost(principal), { page: 1, pageSize: 100 }));
}

countRoutes.post("/stock-counts/:id/submit", count, idempotent(), (context) => moveCount(context, "submit", "submitted"));
countRoutes.post("/stock-counts/:id/cancel", count, idempotent(), validateJson(countNoteSchema), (context) => moveCount(context, "cancel", "cancelled", context.req.valid("json").note));
/** Back to being counted, for a recount of what looked wrong. */
countRoutes.post("/stock-counts/:id/reopen", approve, idempotent(), validateJson(countNoteSchema), (context) => moveCount(context, "reopen", "counting", context.req.valid("json").note));

/** Approves the variance: posts one adjustment through the usual function. */
countRoutes.post("/stock-counts/:id/approve", approve, idempotent(), validateJson(countNoteSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  const { note } = context.req.valid("json");
  let adjustmentId: string | null;
  try {
    adjustmentId = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string | null }>(sql`select approve_stock_count(${businessId}::uuid, ${id}::uuid, ${note}, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return response;
    throw error;
  }
  await auditPrincipal(context, principal, "stock_count", id, "approve", null, { adjustmentId });
  return context.json(await loadCount(businessId, id, canSeeCost(principal), { page: 1, pageSize: 100 }));
});
