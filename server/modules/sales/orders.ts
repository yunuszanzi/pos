import { eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { businessSettings } from "../../../db/schema";
import { priceConversion } from "../../../shared/quotations";
import { convertQuotationSchema, salesOrderSchema, type ConvertQuotationInput, type SalesOrderInput } from "../../../shared/schemas/salesOrders";
import { formatQuantity, parseQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { escapeLike, quantityText } from "../products/service";
import { priceDocument } from "./documentPricing";
import { resolveBranchId, resolveOrderLocationId } from "./location";

// Sales orders (FR-SO-01) and turning a quotation into one (FR-QUO-04). An order reserves stock; it moves none.

export const salesOrderRoutes = new Hono();

const view = requirePermission("sales_orders.view");
const manage = requirePermission("sales_orders.manage");
const paisa = (value: unknown) => Number(value);
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);
const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});

const functionErrors: Array<[prefix: string, status: 404 | 409 | 422, code: string]> = [
  ["NOT_FOUND", 404, "NOT_FOUND"],
  ["INVALID_CUSTOMER", 422, "INVALID_CUSTOMER"],
  ["INVALID_LOCATION", 422, "INVALID_LOCATION"],
  ["INVALID_LINE", 422, "INVALID_LINE"],
  ["ORDER_TOTAL_MISMATCH", 422, "ORDER_TOTAL_MISMATCH"],
  ["QUOTATION_EXPIRED", 409, "QUOTATION_EXPIRED"],
  ["CONVERSION_EXCEEDS_QUOTATION", 409, "CONVERSION_EXCEEDS_QUOTATION"],
  ["INVALID_TRANSITION", 409, "INVALID_TRANSITION"],
];

/** The database says which SKU ran short by id; the person needs its name and the numbers. */
async function describeShortage(businessId: string, message: string): Promise<string> {
  const found = /variant ([0-9a-f-]{36}) has (-?[\d.]+) available \((-?[\d.]+) on hand, (-?[\d.]+) reserved\), needs ([\d.]+)/i.exec(message);
  if (!found) return "Not enough stock available to reserve for this order";
  const [row] = await db.execute<{ name: string; sku: string }>(sql`
    select p.name, v.sku from product_variants v join products p on p.id = v.product_id where v.id = ${found[1]} and v.business_id = ${businessId}
  `);
  return `Not enough stock available${row ? ` of ${row.name} (${row.sku})` : ""}: ${quantityText(found[2])} available (${quantityText(found[3])} on hand, ${quantityText(found[4])} already promised to other orders), ${quantityText(found[5])} needed (counted in the base unit).`;
}

async function failed(context: Context, businessId: string, error: unknown): Promise<Response | null> {
  const message = dbErrorMessage(error);
  if (message.includes("STOCK_INSUFFICIENT")) return apiError(context, 409, "STOCK_INSUFFICIENT", await describeShortage(businessId, message));
  const known = functionErrors.find(([prefix]) => message.includes(prefix));
  return known ? apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message) : null;
}

export async function loadSalesOrder(businessId: string, id: string) {
  const [row] = await db.execute(sql`
    select o.*, c.name as customer_name, c.phone as customer_phone, c.ntn as customer_ntn, c.strn as customer_strn, b.name as branch_name, l.name as location_name, q.number as quotation_number
    from sales_orders o join customers c on c.id = o.customer_id join branches b on b.id = o.branch_id join locations l on l.id = o.location_id
    left join quotations q on q.id = o.quotation_id
    where o.business_id = ${businessId} and o.id = ${id}`);
  if (!row) return null;
  const lines = await db.execute(sql`select * from sales_order_lines where business_id = ${businessId} and order_id = ${id} order by line_no`);
  return {
    id: String(row.id), number: String(row.number), status: String(row.status), customerId: String(row.customer_id), customerName: String(row.customer_name),
    customerPhone: String(row.customer_phone ?? ""), customerNtn: row.customer_ntn ? String(row.customer_ntn) : null, customerStrn: row.customer_strn ? String(row.customer_strn) : null,
    branchId: String(row.branch_id), branchName: String(row.branch_name), locationId: String(row.location_id), locationName: String(row.location_name),
    quotationId: row.quotation_id ? String(row.quotation_id) : null, quotationNumber: row.quotation_number ? String(row.quotation_number) : null,
    customerPo: String(row.customer_po), orderDate: day(row.order_date), deliveryDate: day(row.delivery_date), deliveryAddress: String(row.delivery_address), note: String(row.note),
    taxMode: String(row.tax_mode), grossPaisa: paisa(row.gross_paisa), lineDiscountPaisa: paisa(row.line_discount_paisa), invoiceDiscountPaisa: paisa(row.invoice_discount_paisa),
    taxablePaisa: paisa(row.taxable_paisa), taxPaisa: paisa(row.tax_paisa), roundingPaisa: paisa(row.rounding_paisa), totalPaisa: paisa(row.total_paisa), createdAt: iso(row.created_at),
    lines: lines.map((line) => ({
      id: String(line.id), lineNo: Number(line.line_no), variantId: String(line.variant_id), unitId: String(line.unit_id), productName: String(line.product_name),
      variantName: String(line.variant_name), sku: String(line.sku), unitName: String(line.unit_name), hsCode: line.hs_code ? String(line.hs_code) : null,
      quantity: quantityText(String(line.qty_entered)), factorToBase: quantityText(String(line.factor_to_base)), qtyBase: quantityText(String(line.qty_base)),
      deliveredBase: quantityText(String(line.delivered_base)), invoicedBase: quantityText(String(line.invoiced_base)),
      remainingBase: formatQuantity(parseQuantity(String(line.qty_base)) - parseQuantity(String(line.delivered_base))),
      unitPricePaisa: paisa(line.unit_price_paisa), grossPaisa: paisa(line.gross_paisa), lineDiscountPaisa: paisa(line.line_discount_paisa),
      invoiceDiscountSharePaisa: paisa(line.invoice_discount_share_paisa), netPaisa: paisa(line.net_paisa), taxRateBps: Number(line.tax_rate_bps),
      taxPaisa: paisa(line.tax_paisa), totalPaisa: paisa(line.total_paisa),
    })),
  };
}

/** What the stock looks like after an order was taken or let go, so the screen can update without asking again (technical-plan 5.7). */
async function stockOfOrder(businessId: string, orderId: string) {
  const rows = await db.execute<{ variant_id: string; on_hand: string; reserved: string }>(sql`
    select b.variant_id, b.on_hand::text, b.reserved::text from stock_balances b
    where b.business_id = ${businessId} and (b.variant_id, b.location_id) in (
      select l.variant_id, o.location_id from sales_order_lines l join sales_orders o on o.id = l.order_id where o.id = ${orderId})`);
  return rows.map((row) => ({
    variantId: row.variant_id, onHand: quantityText(row.on_hand), reserved: quantityText(row.reserved),
    available: formatQuantity(parseQuantity(row.on_hand) - parseQuantity(row.reserved)),
  }));
}

salesOrderRoutes.get("/sales-orders", view, async (context) => {
  const principal = getPrincipal(context);
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const status = context.req.query("status") ?? "";
  const customerId = context.req.query("customerId");
  const search = context.req.query("q")?.trim();
  const filters = [sql`o.business_id = ${principal.businessId!}`];
  if (["open", "partly_delivered", "delivered", "closed", "cancelled"].includes(status)) filters.push(sql`o.status = ${status}`);
  // "Active" is everything still holding stock or waiting to be billed.
  if (status === "active") filters.push(sql`o.status in ('open', 'partly_delivered', 'delivered')`);
  if (customerId && /^[0-9a-f-]{36}$/i.test(customerId)) filters.push(sql`o.customer_id = ${customerId}`);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    filters.push(sql`(o.number ilike ${pattern} or o.customer_po ilike ${pattern} or c.name ilike ${pattern})`);
  }
  const rows = await db.execute(sql`
    select o.id, o.number, o.status, o.order_date, o.delivery_date, o.total_paisa, o.customer_po, c.name as customer_name, count(*) over () as total
    from sales_orders o join customers c on c.id = o.customer_id
    where ${sql.join(filters, sql` and `)}
    order by o.order_date desc, o.number desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id), number: String(row.number), status: String(row.status), orderDate: day(row.order_date), deliveryDate: day(row.delivery_date),
      totalPaisa: paisa(row.total_paisa), customerPo: String(row.customer_po), customerName: String(row.customer_name),
    })),
    page, pageSize, total: rows.length ? paisa(rows[0].total) : 0,
  });
});

salesOrderRoutes.get("/sales-orders/:id", view, async (context) => {
  const found = await loadSalesOrder(getPrincipal(context).businessId!, paramId(context));
  return found ? context.json(found) : apiError(context, 404, "NOT_FOUND", "Sales order not found");
});

async function takeOrder(context: Context, businessId: string, payload: Record<string, unknown>) {
  const principal = getPrincipal(context);
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select take_sales_order(${JSON.stringify(payload)}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
    return { id };
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return { response };
    throw error;
  }
}

async function orderContext(context: Context, businessId: string, input: { branchId?: string; locationId?: string }) {
  const principal = getPrincipal(context);
  const branchId = await resolveBranchId(businessId, input.branchId, principal.terminalId);
  if (!branchId) return { response: apiError(context, 422, "INVALID_BRANCH", "This branch is not available") };
  const locationId = await resolveOrderLocationId(businessId, branchId, input.locationId);
  if (!locationId) return { response: apiError(context, 422, "INVALID_LOCATION", "There is no store location to reserve stock in") };
  const [settings] = await db.select({ allowNegativeStock: businessSettings.allowNegativeStock }).from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1);
  return { branchId, locationId, allowNegativeStock: settings?.allowNegativeStock ?? false };
}

/** An order written directly, priced at the customer's tier. */
salesOrderRoutes.post("/sales-orders", manage, idempotent(), validateJson(salesOrderSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input: SalesOrderInput = context.req.valid("json");
  const where = await orderContext(context, businessId, input);
  if ("response" in where) return where.response;
  const result = await priceDocument(context, principal, { customerId: input.customerId, lines: input.lines, invoiceDiscount: input.invoiceDiscount });
  if ("response" in result) return result.response;
  const { priced } = result;
  const taken = await takeOrder(context, businessId, {
    business_id: businessId, location_id: where.locationId, customer_id: priced.customerId, allow_negative_stock: where.allowNegativeStock, customer_po: input.customerPo ?? "",
    delivery_date: input.deliveryDate ?? null, delivery_address: input.deliveryAddress ?? "", note: input.note ?? "", tax_mode: priced.taxMode, ...priced.amounts, lines: priced.lines,
  });
  if ("response" in taken) return taken.response;
  await auditPrincipal(context, principal, "sales_order", taken.id, "create", null, { totalPaisa: priced.amounts.total_paisa, lines: input.lines.length });
  return context.json({ order: await loadSalesOrder(businessId, taken.id), stock: await stockOfOrder(businessId, taken.id) }, 201);
});

/** Turns a quotation, in whole or in part, into an order at the quoted prices (FR-QUO-04). */
salesOrderRoutes.post("/quotations/:id/convert-to-order", manage, idempotent(), validateJson(convertQuotationSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const quotationId = paramId(context);
  const input: ConvertQuotationInput = context.req.valid("json");

  const [quote] = await db.execute(sql`select * from quotations where id = ${quotationId} and business_id = ${businessId}`);
  if (!quote) return apiError(context, 404, "NOT_FOUND", "Quotation not found");
  const customerId = quote.customer_id ? String(quote.customer_id) : input.customerId ?? null;
  if (!customerId) return apiError(context, 422, "CUSTOMER_REQUIRED", "This quotation is for a prospect. Choose the customer the order is for.");
  if (quote.customer_id && input.customerId && input.customerId !== String(quote.customer_id)) {
    return apiError(context, 422, "INVALID_CUSTOMER", "The order must be for the customer the quotation was written for");
  }
  const lines = await db.execute(sql`select * from quotation_lines where quotation_id = ${quotationId} and business_id = ${businessId} order by line_no`);

  // Without picks, everything not yet ordered is taken. Quantities are in the unit each line was quoted in.
  const remainingMilli = (line: Record<string, unknown>) =>
    Math.floor(((parseQuantity(String(line.qty_base)) - parseQuantity(String(line.converted_base))) * 1000) / parseQuantity(String(line.factor_to_base)));
  const picks = input.picks
    ? input.picks.map((pick) => ({ quotationLineId: pick.quotationLineId, quantityMilli: parseQuantity(pick.quantity) }))
    : lines.filter((line) => remainingMilli(line) > 0).map((line) => ({ quotationLineId: String(line.id), quantityMilli: remainingMilli(line) }));
  if (!picks.length) return apiError(context, 409, "CONVERSION_EXCEEDS_QUOTATION", "Everything on this quotation has already been ordered");
  const seen = new Set<string>();
  for (const pick of picks) {
    const line = lines.find((entry) => String(entry.id) === pick.quotationLineId);
    if (!line) return apiError(context, 422, "INVALID_LINE", "A line is not on this quotation");
    if (seen.has(pick.quotationLineId)) return apiError(context, 422, "INVALID_LINE", "A quotation line can be named once");
    seen.add(pick.quotationLineId);
    if (pick.quantityMilli > remainingMilli(line)) {
      return apiError(context, 409, "CONVERSION_EXCEEDS_QUOTATION", `${line.sku}: ${formatQuantity(remainingMilli(line))} left to order, ${formatQuantity(pick.quantityMilli)} asked for`);
    }
  }

  const where = await orderContext(context, businessId, { branchId: input.branchId ?? String(quote.branch_id), locationId: input.locationId });
  if ("response" in where) return where.response;
  const taxMode = String(quote.tax_mode) as "inclusive" | "exclusive";
  const priced = priceConversion({
    taxMode,
    lines: lines.map((line) => ({ id: String(line.id), quantity: quantityText(String(line.qty_entered)), unitPricePaisa: paisa(line.unit_price_paisa), lineDiscountPaisa: paisa(line.line_discount_paisa), taxRateBps: Number(line.tax_rate_bps) })),
    invoiceDiscountPaisa: paisa(quote.invoice_discount_paisa),
    picks,
  });
  const taken = await takeOrder(context, businessId, {
    business_id: businessId, location_id: where.locationId, customer_id: customerId, quotation_id: quotationId, allow_negative_stock: where.allowNegativeStock, customer_po: input.customerPo ?? "",
    delivery_date: input.deliveryDate ?? null, delivery_address: input.deliveryAddress ?? "", note: input.note ?? "", tax_mode: taxMode,
    gross_paisa: priced.grossPaisa, line_discount_paisa: priced.lineDiscountPaisa, invoice_discount_paisa: priced.invoiceDiscountPaisa, taxable_paisa: priced.taxablePaisa,
    tax_paisa: priced.taxPaisa, rounding_paisa: priced.roundingPaisa, total_paisa: priced.totalPaisa,
    lines: picks.map((pick, index) => {
      const line = lines.find((entry) => String(entry.id) === pick.quotationLineId)!;
      const out = priced.lines[index];
      const entered = pick.quantityMilli;
      return {
        line_no: index + 1, quotation_line_id: pick.quotationLineId, variant_id: line.variant_id, unit_id: line.unit_id, product_name: line.product_name, variant_name: line.variant_name,
        sku: line.sku, unit_name: line.unit_name, hs_code: line.hs_code, qty_entered: formatQuantity(entered), factor_to_base: quantityText(String(line.factor_to_base)),
        qty_base: formatQuantity((entered * parseQuantity(String(line.factor_to_base))) / 1000), unit_price_paisa: paisa(line.unit_price_paisa), gross_paisa: out.grossPaisa,
        line_discount_paisa: out.lineDiscountPaisa, invoice_discount_share_paisa: out.invoiceDiscountSharePaisa, net_paisa: out.netPaisa, tax_rate_bps: Number(line.tax_rate_bps),
        tax_included: taxMode === "inclusive", taxable_paisa: out.taxablePaisa, tax_paisa: out.taxPaisa, total_paisa: out.totalPaisa,
      };
    }),
  });
  if ("response" in taken) return taken.response;
  await auditPrincipal(context, principal, "sales_order", taken.id, "create", null, { quotationId, lines: picks.length, totalPaisa: priced.totalPaisa });
  await auditPrincipal(context, principal, "quotation", quotationId, "convert", null, { orderId: taken.id });
  return context.json({ order: await loadSalesOrder(businessId, taken.id), stock: await stockOfOrder(businessId, taken.id) }, 201);
});

async function moveOrder(context: Context, action: "cancel" | "close", status: "cancelled" | "closed") {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_sales_order_status(${businessId}::uuid, ${id}::uuid, ${status}, ${getActorId(principal)})`);
    });
  } catch (error) {
    const response = await failed(context, businessId, error);
    if (response) return response;
    throw error;
  }
  await auditPrincipal(context, principal, "sales_order", id, action, null, { status });
  return context.json({ order: await loadSalesOrder(businessId, id), stock: await stockOfOrder(businessId, id) });
}

salesOrderRoutes.post("/sales-orders/:id/cancel", manage, idempotent(), (context) => moveOrder(context, "cancel", "cancelled"));
salesOrderRoutes.post("/sales-orders/:id/close", manage, idempotent(), (context) => moveOrder(context, "close", "closed"));

