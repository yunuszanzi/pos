import { eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { businessSettings } from "../../../db/schema";
import { deliveryChallanSchema, dispatchSchema, returnChallanSchema, type DeliveryChallanInput } from "../../../shared/schemas/deliveryChallans";
import { formatQuantity, parseQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { escapeLike, quantityText } from "../products/service";

// Delivery challans (FR-SO-02, FR-SO-06). Stock leaves when a challan is dispatched, not when it is written.

export const challanRoutes = new Hono();

const view = requirePermission("delivery.view");
const manage = requirePermission("delivery.manage");
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});

const functionErrors: Array<[prefix: string, status: 404 | 409 | 422, code: string]> = [
  ["NOT_FOUND", 404, "NOT_FOUND"],
  ["INVALID_LINE", 422, "INVALID_LINE"],
  ["ORDER_NOT_DELIVERABLE", 409, "ORDER_NOT_DELIVERABLE"],
  ["DELIVERY_EXCEEDS_ORDER", 409, "DELIVERY_EXCEEDS_ORDER"],
  ["DELIVERY_BILLED", 409, "DELIVERY_BILLED"],
  ["INVALID_TRANSITION", 409, "INVALID_TRANSITION"],
];

/** The database says which SKU ran short by id; the person needs its name and the numbers. */
async function describeShortage(businessId: string, message: string): Promise<string> {
  const found = /variant ([0-9a-f-]{36}) has (-?[\d.]+) on hand, needs ([\d.]+)/i.exec(message);
  if (!found) return "Not enough stock to dispatch this challan";
  const [row] = await db.execute<{ name: string; sku: string }>(sql`
    select p.name, v.sku from product_variants v join products p on p.id = v.product_id where v.id = ${found[1]} and v.business_id = ${businessId}
  `);
  return `Not enough stock${row ? ` of ${row.name} (${row.sku})` : ""} to dispatch: ${quantityText(found[2])} on hand, ${quantityText(found[3])} needed (counted in the base unit).`;
}

async function failed(context: Context, businessId: string, error: unknown): Promise<Response | null> {
  const message = dbErrorMessage(error);
  if (message.includes("STOCK_INSUFFICIENT")) return apiError(context, 409, "STOCK_INSUFFICIENT", await describeShortage(businessId, message));
  const known = functionErrors.find(([prefix]) => message.includes(prefix));
  return known ? apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message) : null;
}

export async function loadChallan(businessId: string, id: string) {
  const [row] = await db.execute(sql`
    select c.*, o.number as order_number, o.customer_po, cu.name as customer_name, cu.phone as customer_phone, b.name as branch_name, l.name as location_name
    from delivery_challans c join sales_orders o on o.id = c.order_id join customers cu on cu.id = c.customer_id
    join branches b on b.id = c.branch_id join locations l on l.id = c.location_id
    where c.business_id = ${businessId} and c.id = ${id}`);
  if (!row) return null;
  const lines = await db.execute(sql`select * from delivery_challan_lines where business_id = ${businessId} and challan_id = ${id} order by line_no`);
  return {
    id: String(row.id), number: String(row.number), status: String(row.status), orderId: String(row.order_id), orderNumber: String(row.order_number), customerPo: String(row.customer_po),
    customerId: String(row.customer_id), customerName: String(row.customer_name), customerPhone: String(row.customer_phone ?? ""),
    branchName: String(row.branch_name), locationName: String(row.location_name), driverName: String(row.driver_name), vehicleNo: String(row.vehicle_no), route: String(row.route),
    deliveryAddress: String(row.delivery_address), note: String(row.note), returnReason: String(row.return_reason),
    createdAt: iso(row.created_at), dispatchedAt: iso(row.dispatched_at), deliveredAt: iso(row.delivered_at), returnedAt: iso(row.returned_at),
    lines: lines.map((line) => ({
      id: String(line.id), lineNo: Number(line.line_no), orderLineId: String(line.order_line_id), productName: String(line.product_name), variantName: String(line.variant_name),
      sku: String(line.sku), unitName: String(line.unit_name), quantity: quantityText(String(line.qty_entered)), qtyBase: quantityText(String(line.qty_base)),
    })),
  };
}

challanRoutes.get("/delivery-challans", view, async (context) => {
  const principal = getPrincipal(context);
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const status = context.req.query("status") ?? "";
  const orderId = context.req.query("orderId");
  const search = context.req.query("q")?.trim();
  const filters = [sql`c.business_id = ${principal.businessId!}`];
  if (["pending", "dispatched", "delivered", "returned", "cancelled"].includes(status)) filters.push(sql`c.status = ${status}`);
  // "On the road" is what has left and not yet been confirmed delivered.
  if (status === "active") filters.push(sql`c.status in ('pending', 'dispatched')`);
  if (orderId && /^[0-9a-f-]{36}$/i.test(orderId)) filters.push(sql`c.order_id = ${orderId}`);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    filters.push(sql`(c.number ilike ${pattern} or o.number ilike ${pattern} or cu.name ilike ${pattern} or c.driver_name ilike ${pattern} or c.vehicle_no ilike ${pattern})`);
  }
  const rows = await db.execute(sql`
    select c.id, c.number, c.status, c.driver_name, c.vehicle_no, c.route, c.created_at, c.dispatched_at, o.number as order_number, cu.name as customer_name, count(*) over () as total
    from delivery_challans c join sales_orders o on o.id = c.order_id join customers cu on cu.id = c.customer_id
    where ${sql.join(filters, sql` and `)}
    order by c.created_at desc, c.number desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id), number: String(row.number), status: String(row.status), orderNumber: String(row.order_number), customerName: String(row.customer_name),
      driverName: String(row.driver_name), vehicleNo: String(row.vehicle_no), route: String(row.route), createdAt: iso(row.created_at), dispatchedAt: iso(row.dispatched_at),
    })),
    page, pageSize, total: rows.length ? Number(rows[0].total) : 0,
  });
});

challanRoutes.get("/delivery-challans/:id", view, async (context) => {
  const found = await loadChallan(getPrincipal(context).businessId!, paramId(context));
  return found ? context.json(found) : apiError(context, 404, "NOT_FOUND", "Delivery challan not found");
});

/** What the stock looks like after goods went out or came back, so the screen can update without asking again (technical-plan 5.7). */
async function stockOfChallan(businessId: string, challanId: string) {
  const rows = await db.execute<{ variant_id: string; on_hand: string; reserved: string }>(sql`
    select b.variant_id, b.on_hand::text, b.reserved::text from stock_balances b
    where b.business_id = ${businessId} and (b.variant_id, b.location_id) in (select cl.variant_id, c.location_id from delivery_challan_lines cl join delivery_challans c on c.id = cl.challan_id where c.id = ${challanId})`);
  return rows.map((row) => ({
    variantId: row.variant_id, onHand: quantityText(row.on_hand), reserved: quantityText(row.reserved),
    available: formatQuantity(parseQuantity(row.on_hand) - parseQuantity(row.reserved)),
  }));
}

/** A challan for part or all of an order that is still to be delivered. Nothing moves until it is dispatched. */
challanRoutes.post("/delivery-challans", manage, idempotent(), validateJson(deliveryChallanSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input: DeliveryChallanInput = context.req.valid("json");

  const orderLines = await db.execute(sql`
    select l.id, l.sku, l.qty_base, l.delivered_base, l.factor_to_base,
           coalesce((select sum(cl.qty_base) from delivery_challan_lines cl join delivery_challans c on c.id = cl.challan_id where cl.order_line_id = l.id and c.status = 'pending'), 0) as pending_base
    from sales_order_lines l join sales_orders o on o.id = l.order_id
    where o.business_id = ${businessId} and o.id = ${input.orderId} order by l.line_no`);
  if (!orderLines.length) return apiError(context, 404, "NOT_FOUND", "Sales order not found");

  // Without lines, everything not yet delivered and not already on a pending challan goes, in the unit each line was ordered in.
  const leftMilli = (line: Record<string, unknown>) =>
    Math.floor(((parseQuantity(String(line.qty_base)) - parseQuantity(String(line.delivered_base)) - parseQuantity(String(line.pending_base))) * 1000) / parseQuantity(String(line.factor_to_base)));
  const lines = input.lines
    ? input.lines.map((line) => ({ order_line_id: line.orderLineId, qty_entered: formatQuantity(parseQuantity(line.quantity)) }))
    : orderLines.filter((line) => leftMilli(line) > 0).map((line) => ({ order_line_id: String(line.id), qty_entered: formatQuantity(leftMilli(line)) }));
  if (!lines.length) return apiError(context, 409, "DELIVERY_EXCEEDS_ORDER", "Everything on this order is already delivered or on a pending challan");

  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select create_delivery_challan(${JSON.stringify({
        business_id: businessId, order_id: input.orderId, driver_name: input.driverName, vehicle_no: input.vehicleNo, route: input.route,
        delivery_address: input.deliveryAddress, note: input.note, lines,
      })}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return response;
    throw error;
  }
  await auditPrincipal(context, principal, "delivery_challan", id, "create", null, { orderId: input.orderId, lines: lines.length });
  return context.json({ challan: await loadChallan(businessId, id) }, 201);
});

/** Stock leaves; the order moves on. Driver, vehicle and route may be given here. */
challanRoutes.post("/delivery-challans/:id/dispatch", manage, idempotent(), validateJson(dispatchSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  const input = context.req.valid("json");
  const [settings] = await db.select({ allowNegativeStock: businessSettings.allowNegativeStock }).from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select dispatch_delivery_challan(${businessId}::uuid, ${id}::uuid, ${JSON.stringify({ driver_name: input.driverName, vehicle_no: input.vehicleNo, route: input.route })}::jsonb, ${settings?.allowNegativeStock ?? false}, ${getActorId(principal)})`);
    });
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return response;
    throw error;
  }
  await auditPrincipal(context, principal, "delivery_challan", id, "dispatch", null, {});
  return context.json({ challan: await loadChallan(businessId, id), stock: await stockOfChallan(businessId, id) });
});

async function moveChallan(context: Context, action: "deliver" | "return" | "cancel", status: "delivered" | "returned" | "cancelled", reason = "") {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_delivery_challan_status(${businessId}::uuid, ${id}::uuid, ${status}, ${reason}, ${getActorId(principal)})`);
    });
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return response;
    throw error;
  }
  await auditPrincipal(context, principal, "delivery_challan", id, action, null, { status, reason });
  return context.json({ challan: await loadChallan(businessId, id), stock: await stockOfChallan(businessId, id) });
}

challanRoutes.post("/delivery-challans/:id/deliver", manage, idempotent(), (context) => moveChallan(context, "deliver", "delivered"));
challanRoutes.post("/delivery-challans/:id/cancel", manage, idempotent(), (context) => moveChallan(context, "cancel", "cancelled"));
challanRoutes.post("/delivery-challans/:id/return", manage, idempotent(), validateJson(returnChallanSchema), (context) => moveChallan(context, "return", "returned", context.req.valid("json").reason));
