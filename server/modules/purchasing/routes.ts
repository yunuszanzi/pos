import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { goodsReceiptSchema, purchaseOrderSchema } from "../../../shared/schemas/purchasing";
import { formatQuantity, parseQuantity, toBaseQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { escapeLike, canSeeCost } from "../products/service";

// Purchase orders and goods receipts (FR-PUR-02, FR-PUR-03). Costs are shown and set only by people who may see costs.

export const purchasingRoutes = new Hono();

const view = requirePermission("purchasing.view");
const order = requirePermission("purchasing.order");
const receive = requirePermission("purchasing.receive");
const paisa = (value: unknown) => Number(value);
const quantityText = (value: unknown) => formatQuantity(parseQuantity(String(value)));
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);

const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});

/** Rule violations raised by the posting functions. */
const functionErrors: Array<[prefix: string, status: 404 | 409 | 422, code: string]> = [
  ["NOT_FOUND", 404, "NOT_FOUND"],
  ["INVALID_SUPPLIER", 422, "INVALID_SUPPLIER"],
  ["INVALID_LOCATION", 422, "INVALID_LOCATION"],
  ["INVALID_LINE", 422, "INVALID_LINE"],
  ["ORDER_NOT_EDITABLE", 409, "ORDER_NOT_EDITABLE"],
  ["ORDER_NOT_RECEIVABLE", 409, "ORDER_NOT_RECEIVABLE"],
  ["INVALID_TRANSITION", 409, "INVALID_TRANSITION"],
  ["RECEIPT_EXCEEDS_ORDER", 409, "RECEIPT_EXCEEDS_ORDER"],
];
export function mapFunctionError(context: Context, error: unknown): Response | null {
  const message = dbErrorMessage(error);
  const known = functionErrors.find(([prefix]) => message.includes(prefix));
  return known ? apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message) : null;
}

type Fact = { variant_id: string; unit_id: string; product_name: string; variant_name: string; sku: string; unit_name: string; factor_to_base: string };

/** Names, SKU and unit factors for the variants and units a document uses. Only active stocked SKUs come back. */
export async function factsFor(businessId: string, pairs: Array<{ variantId: string; unitId: string }>): Promise<Map<string, Fact>> {
  if (!pairs.length) return new Map();
  const rows = await db.execute<Fact>(sql`
    select v.id as variant_id, u.id as unit_id, p.name as product_name, v.variant_name, v.sku, u.name as unit_name, pu.factor_to_base::text as factor_to_base
    from product_variants v
    join products p on p.id = v.product_id and p.active and p.product_type = 'stocked'
    join product_units pu on pu.variant_id = v.id
    join units u on u.id = pu.unit_id
    where v.business_id = ${businessId} and v.active
      and (v.id, u.id) in (${sql.join(pairs.map((pair) => sql`(${pair.variantId}::uuid, ${pair.unitId}::uuid)`), sql`, `)})
  `);
  return new Map(rows.map((row) => [`${row.variant_id}|${row.unit_id}`, row]));
}

/** One line of a function payload: the entered quantity and unit, the factor now, and the quantity in base units. */
export function payloadLine(fact: Fact, quantity: string, unitCostPaisa: number, orderLineId?: string) {
  const entered = parseQuantity(quantity);
  const factor = parseQuantity(fact.factor_to_base);
  return {
    order_line_id: orderLineId ?? null, variant_id: fact.variant_id, unit_id: fact.unit_id, product_name: fact.product_name, variant_name: fact.variant_name,
    sku: fact.sku, unit_name: fact.unit_name, qty_entered: formatQuantity(entered), factor_to_base: formatQuantity(factor),
    qty_base: formatQuantity(toBaseQuantity(entered, factor)), unit_cost_paisa: unitCostPaisa,
  };
}

// ---------------------------------------------------------------- purchase orders

async function loadOrder(businessId: string, id: string, withCost: boolean) {
  const [row] = await db.execute(sql`
    select o.*, s.name as supplier_name, l.name as location_name, b.name as branch_name
    from purchase_orders o join suppliers s on s.id = o.supplier_id join locations l on l.id = o.location_id join branches b on b.id = o.branch_id
    where o.business_id = ${businessId} and o.id = ${id}`);
  if (!row) return null;
  const lines = await db.execute(sql`select * from purchase_order_lines where business_id = ${businessId} and order_id = ${id} order by line_no`);
  const receipts = await db.execute(sql`select id, number, received_at, supplier_ref, total_paisa from goods_receipts where business_id = ${businessId} and order_id = ${id} order by received_at, number`);
  return {
    id: String(row.id), number: String(row.number), status: String(row.status), supplierId: String(row.supplier_id), supplierName: String(row.supplier_name),
    locationId: String(row.location_id), locationName: String(row.location_name), branchName: String(row.branch_name), orderDate: day(row.order_date), expectedDate: day(row.expected_date),
    note: String(row.note), createdAt: iso(row.created_at),
    ...(withCost ? { totalPaisa: paisa(row.total_paisa) } : {}),
    lines: lines.map((line) => ({
      id: String(line.id), lineNo: Number(line.line_no), variantId: String(line.variant_id), unitId: String(line.unit_id), productName: String(line.product_name),
      variantName: String(line.variant_name), sku: String(line.sku), unitName: String(line.unit_name), quantity: quantityText(line.qty_entered),
      factorToBase: quantityText(line.factor_to_base), qtyBase: quantityText(line.qty_base), receivedBase: quantityText(line.received_base),
      // What is still to come, in the unit the line was ordered in.
      remainingQuantity: formatQuantity(Math.floor(((parseQuantity(String(line.qty_base)) - parseQuantity(String(line.received_base))) * 1000) / parseQuantity(String(line.factor_to_base)))),
      ...(withCost ? { unitCostPaisa: paisa(line.unit_cost_paisa), lineTotalPaisa: paisa(line.line_total_paisa) } : {}),
    })),
    receipts: receipts.map((receipt) => ({
      id: String(receipt.id), number: String(receipt.number), receivedAt: iso(receipt.received_at), supplierRef: String(receipt.supplier_ref),
      ...(withCost ? { totalPaisa: paisa(receipt.total_paisa) } : {}),
    })),
  };
}

purchasingRoutes.get("/purchase-orders", view, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const status = context.req.query("status") ?? "";
  const supplierId = context.req.query("supplierId");
  const search = context.req.query("q")?.trim();
  const filters = [sql`o.business_id = ${businessId}`];
  if (["draft", "sent", "partly_received", "received", "closed", "cancelled"].includes(status)) filters.push(sql`o.status = ${status}`);
  if (status === "open") filters.push(sql`o.status in ('sent', 'partly_received')`);
  if (supplierId && /^[0-9a-f-]{36}$/i.test(supplierId)) filters.push(sql`o.supplier_id = ${supplierId}`);
  if (search) filters.push(sql`(o.number ilike ${`%${escapeLike(search)}%`} or s.name ilike ${`%${escapeLike(search)}%`})`);
  const rows = await db.execute(sql`
    select o.id, o.number, o.status, o.order_date, o.expected_date, o.total_paisa, s.name as supplier_name, count(*) over () as total
    from purchase_orders o join suppliers s on s.id = o.supplier_id
    where ${sql.join(filters, sql` and `)}
    order by o.order_date desc, o.number desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  const withCost = canSeeCost(principal);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id), number: String(row.number), status: String(row.status), orderDate: day(row.order_date), expectedDate: day(row.expected_date), supplierName: String(row.supplier_name),
      ...(withCost ? { totalPaisa: paisa(row.total_paisa) } : {}),
    })),
    page, pageSize, total: rows.length ? paisa(rows[0].total) : 0,
  });
});

purchasingRoutes.get("/purchase-orders/:id", view, async (context) => {
  const principal = getPrincipal(context);
  const found = await loadOrder(principal.businessId!, paramId(context), canSeeCost(principal));
  return found ? context.json(found) : apiError(context, 404, "NOT_FOUND", "Purchase order not found");
});

/** Builds the lines of an order from what the screen sent, or answers with the reason it cannot. */
async function orderPayload(context: Context, businessId: string, input: ReturnType<typeof purchaseOrderSchema.parse>, id?: string) {
  const facts = await factsFor(businessId, input.lines.map((line) => ({ variantId: line.variantId, unitId: line.unitId })));
  const lines = [];
  for (const line of input.lines) {
    const fact = facts.get(`${line.variantId}|${line.unitId}`);
    if (!fact) return { response: apiError(context, 422, "INVALID_LINE", "A line is not an active stocked product bought in a unit it has") };
    lines.push(payloadLine(fact, line.quantity, line.unitCostPaisa));
  }
  return { payload: { business_id: businessId, id, supplier_id: input.supplierId, location_id: input.locationId, order_date: input.orderDate ?? null, expected_date: input.expectedDate, note: input.note, lines } };
}

async function saveOrder(context: Context, input: ReturnType<typeof purchaseOrderSchema.parse>, id?: string) {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  // Writing a price is for people who may see costs.
  if (!canSeeCost(principal)) return apiError(context, 403, "FORBIDDEN", "You need permission to see costs to write purchase prices");
  const built = await orderPayload(context, businessId, input, id);
  if (built.response) return built.response;
  let savedId: string;
  try {
    savedId = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select save_purchase_order(${JSON.stringify(built.payload)}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const mapped = mapFunctionError(context, error);
    if (mapped) return mapped;
    throw error;
  }
  await auditPrincipal(context, principal, "purchase_order", savedId, id ? "update" : "create", null, { supplierId: input.supplierId, lines: input.lines.length });
  return context.json(await loadOrder(businessId, savedId, true), id ? 200 : 201);
}

purchasingRoutes.post("/purchase-orders", order, validateJson(purchaseOrderSchema), (context) => saveOrder(context, context.req.valid("json")));
purchasingRoutes.put("/purchase-orders/:id", order, validateJson(purchaseOrderSchema), (context) => saveOrder(context, context.req.valid("json"), paramId(context)));

async function moveOrder(context: Context, action: "send" | "cancel" | "close", status: "sent" | "cancelled" | "closed") {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_purchase_order_status(${businessId}::uuid, ${id}::uuid, ${status}, ${getActorId(principal)})`);
    });
  } catch (error) {
    const mapped = mapFunctionError(context, error);
    if (mapped) return mapped;
    throw error;
  }
  await auditPrincipal(context, principal, "purchase_order", id, action, null, { status });
  return context.json(await loadOrder(businessId, id, canSeeCost(principal)));
}

purchasingRoutes.post("/purchase-orders/:id/send", order, idempotent(), (context) => moveOrder(context, "send", "sent"));
purchasingRoutes.post("/purchase-orders/:id/cancel", order, idempotent(), (context) => moveOrder(context, "cancel", "cancelled"));
purchasingRoutes.post("/purchase-orders/:id/close", order, idempotent(), (context) => moveOrder(context, "close", "closed"));

// ---------------------------------------------------------------- goods receipts

async function loadReceipt(businessId: string, id: string, withCost: boolean) {
  const [row] = await db.execute(sql`
    select r.*, s.name as supplier_name, l.name as location_name, b.name as branch_name, o.number as order_number, u.display_name as received_by
    from goods_receipts r join suppliers s on s.id = r.supplier_id join locations l on l.id = r.location_id join branches b on b.id = r.branch_id
    left join purchase_orders o on o.id = r.order_id left join users u on u.id = r.created_by
    where r.business_id = ${businessId} and r.id = ${id}`);
  if (!row) return null;
  const lines = await db.execute(sql`select * from goods_receipt_lines where business_id = ${businessId} and receipt_id = ${id} order by line_no`);
  return {
    id: String(row.id), number: String(row.number), supplierId: String(row.supplier_id), supplierName: String(row.supplier_name), locationName: String(row.location_name),
    branchName: String(row.branch_name), orderId: row.order_id ? String(row.order_id) : null, orderNumber: row.order_number ? String(row.order_number) : null,
    supplierRef: String(row.supplier_ref), note: String(row.note), receivedAt: iso(row.received_at), receivedBy: row.received_by ? String(row.received_by) : null,
    ...(withCost ? { totalPaisa: paisa(row.total_paisa) } : {}),
    lines: lines.map((line) => ({
      id: String(line.id), lineNo: Number(line.line_no), orderLineId: line.order_line_id ? String(line.order_line_id) : null, variantId: String(line.variant_id),
      productName: String(line.product_name), variantName: String(line.variant_name), sku: String(line.sku), unitName: String(line.unit_name),
      quantity: quantityText(line.qty_entered), qtyBase: quantityText(line.qty_base), billedBase: quantityText(line.billed_base),
      ...(withCost ? { unitCostPaisa: paisa(line.unit_cost_paisa), costPerBasePaisa: paisa(line.cost_per_base_paisa), lineValuePaisa: paisa(line.line_value_paisa) } : {}),
    })),
  };
}

purchasingRoutes.get("/goods-receipts", view, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const supplierId = context.req.query("supplierId");
  const orderId = context.req.query("orderId");
  const search = context.req.query("q")?.trim();
  const filters = [sql`r.business_id = ${businessId}`];
  if (supplierId && /^[0-9a-f-]{36}$/i.test(supplierId)) filters.push(sql`r.supplier_id = ${supplierId}`);
  if (orderId && /^[0-9a-f-]{36}$/i.test(orderId)) filters.push(sql`r.order_id = ${orderId}`);
  if (search) filters.push(sql`(r.number ilike ${`%${escapeLike(search)}%`} or s.name ilike ${`%${escapeLike(search)}%`} or r.supplier_ref ilike ${`%${escapeLike(search)}%`})`);
  const rows = await db.execute(sql`
    select r.id, r.number, r.received_at, r.supplier_ref, r.total_paisa, s.name as supplier_name, o.number as order_number, count(*) over () as total
    from goods_receipts r join suppliers s on s.id = r.supplier_id left join purchase_orders o on o.id = r.order_id
    where ${sql.join(filters, sql` and `)}
    order by r.received_at desc, r.number desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  const withCost = canSeeCost(principal);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id), number: String(row.number), receivedAt: iso(row.received_at), supplierRef: String(row.supplier_ref), supplierName: String(row.supplier_name),
      orderNumber: row.order_number ? String(row.order_number) : null, ...(withCost ? { totalPaisa: paisa(row.total_paisa) } : {}),
    })),
    page, pageSize, total: rows.length ? paisa(rows[0].total) : 0,
  });
});

purchasingRoutes.get("/goods-receipts/:id", view, async (context) => {
  const principal = getPrincipal(context);
  const found = await loadReceipt(principal.businessId!, paramId(context), canSeeCost(principal));
  return found ? context.json(found) : apiError(context, 404, "NOT_FOUND", "Goods receipt not found");
});

/** Receives goods: against an order (its lines, at its prices unless a different price is given) or without one. */
purchasingRoutes.post("/goods-receipts", receive, idempotent(), validateJson(goodsReceiptSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  const mayPrice = canSeeCost(principal);

  let lines: Array<ReturnType<typeof payloadLine>>;
  if (input.orderId) {
    const orderLines = await db.execute<{ id: string; variant_id: string; unit_id: string; unit_cost_paisa: string }>(sql`
      select id, variant_id, unit_id, unit_cost_paisa from purchase_order_lines where business_id = ${businessId} and order_id = ${input.orderId}`);
    const byId = new Map(orderLines.map((row) => [row.id, row]));
    if (input.lines.some((line) => !line.orderLineId || !byId.has(line.orderLineId))) return apiError(context, 422, "INVALID_LINE", "Every line must be a line of this order");
    const facts = await factsFor(businessId, orderLines.map((row) => ({ variantId: row.variant_id, unitId: row.unit_id })));
    lines = [];
    for (const line of input.lines) {
      const orderLine = byId.get(line.orderLineId!)!;
      const fact = facts.get(`${orderLine.variant_id}|${orderLine.unit_id}`);
      if (!fact) return apiError(context, 422, "INVALID_LINE", "A line is not an active stocked product bought in a unit it has");
      // A price different from the order's is for people who may see costs; everyone else receives at the order's price.
      const cost = mayPrice && line.unitCostPaisa !== undefined ? line.unitCostPaisa : paisa(orderLine.unit_cost_paisa);
      lines.push(payloadLine(fact, line.quantity, cost, orderLine.id));
    }
  } else {
    if (!mayPrice) return apiError(context, 403, "FORBIDDEN", "You need permission to see costs to receive goods without an order");
    if (input.lines.some((line) => !line.variantId || !line.unitId || line.unitCostPaisa === undefined)) return apiError(context, 422, "INVALID_LINE", "Each line needs an item, a unit and a price");
    const facts = await factsFor(businessId, input.lines.map((line) => ({ variantId: line.variantId!, unitId: line.unitId! })));
    lines = [];
    for (const line of input.lines) {
      const fact = facts.get(`${line.variantId}|${line.unitId}`);
      if (!fact) return apiError(context, 422, "INVALID_LINE", "A line is not an active stocked product bought in a unit it has");
      lines.push(payloadLine(fact, line.quantity, line.unitCostPaisa!));
    }
  }

  const payload = { business_id: businessId, supplier_id: input.supplierId, location_id: input.locationId, order_id: input.orderId, supplier_ref: input.supplierRef, note: input.note, lines };
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select post_goods_receipt(${JSON.stringify(payload)}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const mapped = mapFunctionError(context, error);
    if (mapped) return mapped;
    throw error;
  }
  await auditPrincipal(context, principal, "goods_receipt", id, "post", null, { supplierId: input.supplierId, orderId: input.orderId, lines: lines.length });
  const stock = await db.execute<{ variant_id: string; on_hand: string; avg_cost_paisa: string }>(sql`
    select variant_id, on_hand::text as on_hand, avg_cost_paisa::text as avg_cost_paisa from stock_balances
    where business_id = ${businessId} and location_id = ${input.locationId} and variant_id in (${sql.join(lines.map((line) => sql`${line.variant_id}::uuid`), sql`, `)})`);
  return context.json({
    receipt: await loadReceipt(businessId, id, mayPrice),
    stock: stock.map((row) => ({ variantId: row.variant_id, onHand: quantityText(row.on_hand), ...(mayPrice ? { averageCostPaisa: paisa(row.avg_cost_paisa) } : {}) })),
  }, 201);
});
