import { eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { businessSettings } from "../../../db/schema";
import { receiveTransferSchema, stockTransferSchema, transferStatuses } from "../../../shared/schemas/transfers";
import { formatQuantity, parseQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { canSeeCost, escapeLike, quantityText } from "../products/service";

// Stock transfers between locations (FR-INV-04). Stock leaves the source on dispatch and enters the destination on receipt; between
// the two it is in transit, on no shelf.

export const transferRoutes = new Hono();

const view = requirePermission("transfers.view");
const manage = requirePermission("transfers.manage");
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});

const functionErrors: Array<[prefix: string, status: 404 | 409 | 422, code: string]> = [
  ["NOT_FOUND", 404, "NOT_FOUND"],
  ["SAME_LOCATION", 422, "SAME_LOCATION"],
  ["LOCATION_INACTIVE", 409, "LOCATION_INACTIVE"],
  ["INVALID_LINE", 422, "INVALID_LINE"],
  ["RECEIVED_MORE_THAN_SENT", 409, "RECEIVED_MORE_THAN_SENT"],
  ["INVALID_TRANSITION", 409, "INVALID_TRANSITION"],
];

async function describeShortage(businessId: string, message: string): Promise<string> {
  const found = /variant ([0-9a-f-]{36}) has (-?[\d.]+) on hand, needs ([\d.]+)/i.exec(message);
  if (!found) return "Not enough stock to send this transfer";
  const [row] = await db.execute<{ name: string; sku: string }>(sql`
    select p.name, v.sku from product_variants v join products p on p.id = v.product_id where v.id = ${found[1]} and v.business_id = ${businessId}`);
  return `Not enough stock${row ? ` of ${row.name} (${row.sku})` : ""} at the source: ${quantityText(found[2])} on hand, ${quantityText(found[3])} to send (counted in the base unit).`;
}

async function failed(context: Context, businessId: string, error: unknown): Promise<Response | null> {
  const message = dbErrorMessage(error);
  if (message.includes("STOCK_INSUFFICIENT")) return apiError(context, 409, "STOCK_INSUFFICIENT", await describeShortage(businessId, message));
  const known = functionErrors.find(([prefix]) => message.includes(prefix));
  return known ? apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message) : null;
}

export async function loadTransfer(businessId: string, id: string, withCost: boolean) {
  const [row] = await db.execute(sql`
    select t.*, f.name as from_name, d.name as to_name, d.type as to_type, f.type as from_type, b.name as branch_name,
           cu.display_name as created_by_name, du.display_name as dispatched_by_name, ru.display_name as received_by_name
    from stock_transfers t join locations f on f.id = t.from_location_id join locations d on d.id = t.to_location_id join branches b on b.id = t.branch_id
    left join users cu on cu.id = t.created_by left join users du on du.id = t.dispatched_by left join users ru on ru.id = t.received_by
    where t.business_id = ${businessId} and t.id = ${id}`);
  if (!row) return null;
  const lines = await db.execute(sql`select * from stock_transfer_lines where business_id = ${businessId} and transfer_id = ${id} order by line_no`);
  return {
    id: String(row.id), number: String(row.number), status: String(row.status), branchName: String(row.branch_name),
    fromLocationId: String(row.from_location_id), fromName: String(row.from_name), fromType: String(row.from_type),
    toLocationId: String(row.to_location_id), toName: String(row.to_name), toType: String(row.to_type),
    note: String(row.note), receiveNote: String(row.receive_note),
    createdAt: iso(row.created_at), createdByName: row.created_by_name ? String(row.created_by_name) : null,
    dispatchedAt: iso(row.dispatched_at), dispatchedByName: row.dispatched_by_name ? String(row.dispatched_by_name) : null,
    receivedAt: iso(row.received_at), receivedByName: row.received_by_name ? String(row.received_by_name) : null, cancelledAt: iso(row.cancelled_at),
    lines: lines.map((line) => {
      const sent = String(line.qty_base);
      const arrived = line.received_base === null ? null : String(line.received_base);
      return {
        id: String(line.id), lineNo: Number(line.line_no), variantId: String(line.variant_id), unitId: String(line.unit_id),
        productName: String(line.product_name), variantName: String(line.variant_name), sku: String(line.sku), unitName: String(line.unit_name),
        quantity: quantityText(String(line.qty_entered)), factorToBase: quantityText(String(line.factor_to_base)), qtyBase: quantityText(sent),
        receivedBase: arrived === null ? null : quantityText(arrived),
        // What was sent and did not arrive, in the base unit.
        shortageBase: arrived === null ? null : quantityText(formatQuantity(parseQuantity(sent) - parseQuantity(arrived))),
        ...(withCost ? { costPaisa: Number(line.cost_paisa) } : {}),
      };
    }),
  };
}

transferRoutes.get("/stock-transfers", view, async (context) => {
  const principal = getPrincipal(context);
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const status = context.req.query("status") ?? "";
  const locationId = context.req.query("locationId");
  const search = context.req.query("q")?.trim();
  const filters = [sql`t.business_id = ${principal.businessId!}`];
  if ((transferStatuses as readonly string[]).includes(status)) filters.push(sql`t.status = ${status}`);
  if (status === "open") filters.push(sql`t.status in ('requested', 'dispatched')`);
  if (locationId && /^[0-9a-f-]{36}$/i.test(locationId)) filters.push(sql`(t.from_location_id = ${locationId} or t.to_location_id = ${locationId})`);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    filters.push(sql`(t.number ilike ${pattern} or t.note ilike ${pattern})`);
  }
  const rows = await db.execute(sql`
    select t.id, t.number, t.status, t.created_at, t.dispatched_at, t.received_at, f.name as from_name, d.name as to_name,
           (select count(*) from stock_transfer_lines l where l.transfer_id = t.id)::int as items, count(*) over () as total
    from stock_transfers t join locations f on f.id = t.from_location_id join locations d on d.id = t.to_location_id
    where ${sql.join(filters, sql` and `)}
    order by t.created_at desc, t.number desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id), number: String(row.number), status: String(row.status), fromName: String(row.from_name), toName: String(row.to_name), items: Number(row.items),
      createdAt: iso(row.created_at), dispatchedAt: iso(row.dispatched_at), receivedAt: iso(row.received_at),
    })),
    page, pageSize, total: rows.length ? Number(rows[0].total) : 0,
  });
});

/** Goods that have left a location and not yet arrived: what is on no shelf right now. */
transferRoutes.get("/stock-transfers/in-transit", view, async (context) => {
  const principal = getPrincipal(context);
  const withCost = canSeeCost(principal);
  const rows = await db.execute(sql`
    select t.id as transfer_id, t.number, t.dispatched_at, f.name as from_name, d.name as to_name, l.variant_id, l.sku, l.product_name, l.variant_name, l.qty_base, l.cost_paisa
    from stock_transfers t join stock_transfer_lines l on l.transfer_id = t.id join locations f on f.id = t.from_location_id join locations d on d.id = t.to_location_id
    where t.business_id = ${principal.businessId!} and t.status = 'dispatched' order by t.dispatched_at, t.number, l.line_no limit 500`);
  return context.json({
    data: rows.map((row) => ({
      transferId: String(row.transfer_id), number: String(row.number), dispatchedAt: iso(row.dispatched_at), fromName: String(row.from_name), toName: String(row.to_name),
      variantId: String(row.variant_id), sku: String(row.sku), productName: String(row.product_name), variantName: String(row.variant_name), qtyBase: quantityText(String(row.qty_base)),
      ...(withCost ? { valuePaisa: Math.round(Number(row.qty_base) * Number(row.cost_paisa)) } : {}),
    })),
  });
});

transferRoutes.get("/stock-transfers/:id", view, async (context) => {
  const principal = getPrincipal(context);
  const found = await loadTransfer(principal.businessId!, paramId(context), canSeeCost(principal));
  return found ? context.json(found) : apiError(context, 404, "NOT_FOUND", "Stock transfer not found");
});

/** The stock of the two locations after a move, so the screen can update without asking again (technical-plan 5.7). */
async function stockOfTransfer(businessId: string, id: string) {
  const rows = await db.execute<{ variant_id: string; location_id: string; on_hand: string }>(sql`
    select b.variant_id, b.location_id, b.on_hand::text from stock_balances b
    where b.business_id = ${businessId} and (b.variant_id) in (select variant_id from stock_transfer_lines where transfer_id = ${id})
      and b.location_id in (select from_location_id from stock_transfers where id = ${id} union select to_location_id from stock_transfers where id = ${id})`);
  return rows.map((row) => ({ variantId: row.variant_id, locationId: row.location_id, onHand: quantityText(row.on_hand) }));
}

transferRoutes.post("/stock-transfers", manage, idempotent(), validateJson(stockTransferSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select create_stock_transfer(${JSON.stringify({
        business_id: businessId, from_location_id: input.fromLocationId, to_location_id: input.toLocationId, note: input.note,
        lines: input.lines.map((line) => ({ variant_id: line.variantId, unit_id: line.unitId, qty_entered: formatQuantity(parseQuantity(line.quantity)) })),
      })}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return response;
    throw error;
  }
  await auditPrincipal(context, principal, "stock_transfer", id, "create", null, { from: input.fromLocationId, to: input.toLocationId, lines: input.lines.length });
  return context.json({ transfer: await loadTransfer(businessId, id, canSeeCost(principal)) }, 201);
});

async function move(context: Context, action: "dispatch" | "receive" | "cancel", work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], businessId: string, id: string, actor: string | null) => Promise<void>, details: Record<string, unknown> = {}) {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  try {
    await db.transaction((tx) => work(tx, businessId, id, getActorId(principal)));
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return response;
    throw error;
  }
  await auditPrincipal(context, principal, "stock_transfer", id, action, null, details);
  return context.json({ transfer: await loadTransfer(businessId, id, canSeeCost(principal)), stock: await stockOfTransfer(businessId, id) });
}

/** Stock leaves the source. */
transferRoutes.post("/stock-transfers/:id/dispatch", manage, idempotent(), async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const [settings] = await db.select({ allowNegativeStock: businessSettings.allowNegativeStock }).from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1);
  return move(context, "dispatch", async (tx, business, id, actor) => {
    await tx.execute(sql`select dispatch_stock_transfer(${business}::uuid, ${id}::uuid, ${settings?.allowNegativeStock ?? false}, ${actor})`);
  });
});

/** Stock enters the destination: all of it, or what the person counted. */
transferRoutes.post("/stock-transfers/:id/receive", manage, idempotent(), validateJson(receiveTransferSchema), async (context) => {
  const input = context.req.valid("json");
  return move(context, "receive", async (tx, business, id, actor) => {
    await tx.execute(sql`select receive_stock_transfer(${business}::uuid, ${id}::uuid, ${JSON.stringify({
      note: input.note, lines: input.lines.map((line) => ({ line_id: line.lineId, qty_received: formatQuantity(parseQuantity(line.quantity)) })),
    })}::jsonb, ${actor})`);
  }, { short: input.lines.length });
});

transferRoutes.post("/stock-transfers/:id/cancel", manage, idempotent(), (context) =>
  move(context, "cancel", async (tx, business, id, actor) => {
    await tx.execute(sql`select cancel_stock_transfer(${business}::uuid, ${id}::uuid, ${actor})`);
  }));
