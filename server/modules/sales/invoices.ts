import { eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { businessSettings, customers } from "../../../db/schema";
import { priceConversion, type ConversionPick, type QuotedLine } from "../../../shared/quotations";
import { salesInvoiceSchema, type SalesInvoiceInput } from "../../../shared/schemas/salesInvoices";
import { formatQuantity, parseQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, hasPermission, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { canSeeCost, escapeLike, quantityText } from "../products/service";
import { priceDocument } from "./documentPricing";
import { resolveBranchId, resolveOrderLocationId } from "./location";
import { fbrPreflight, queueFbrSubmission, reportNow } from "../../fbr/service";
import { describeShortage } from "./orders";
import { describeCredit, loadInvoice } from "./routes";

// Back-office sales invoices (FR-SO-03, FR-SO-04): written at a desk for a customer on credit, from a sales order (goods already
// delivered), from a quotation, or directly. Paid later through the khata.

export const salesInvoiceRoutes = new Hono();

const view = requirePermission("invoices.view");
const create = requirePermission("invoices.create");
const paisa = (value: unknown) => Number(value);
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});

const functionErrors: Array<[prefix: string, status: 404 | 409 | 422, code: string]> = [
  ["NOT_FOUND", 404, "NOT_FOUND"],
  ["INVALID_CUSTOMER", 422, "INVALID_CUSTOMER"],
  ["INVALID_TERMS", 422, "INVALID_TERMS"],
  ["INVALID_BRANCH", 422, "INVALID_BRANCH"],
  ["INVALID_LOCATION", 422, "INVALID_LOCATION"],
  ["INVALID_LINE", 422, "INVALID_LINE"],
  ["INVOICE_TOTAL_MISMATCH", 422, "INVOICE_TOTAL_MISMATCH"],
  ["ORDER_NOT_BILLABLE", 409, "ORDER_NOT_BILLABLE"],
  ["BILLING_EXCEEDS_DELIVERY", 409, "BILLING_EXCEEDS_DELIVERY"],
  ["QUOTATION_EXPIRED", 409, "QUOTATION_EXPIRED"],
  ["CONVERSION_EXCEEDS_QUOTATION", 409, "CONVERSION_EXCEEDS_QUOTATION"],
  ["INVALID_TRANSITION", 409, "INVALID_TRANSITION"],
];

type Prepared = {
  customerId: string;
  branchId: string;
  locationId: string;
  taxMode: "inclusive" | "exclusive";
  amounts: Record<string, number>;
  lines: Array<Record<string, unknown>>;
  orderId?: string;
  quotationId?: string;
};

type Row = Record<string, unknown>;

/** Lines of an order or a quotation, billed in part: the stored prices and tax rate, discounts in proportion to the quantity. */
function linesFromSource(rows: Row[], picks: ConversionPick[], priced: ReturnType<typeof priceConversion>, taxMode: string, sourceKey: "order_line_id" | "quotation_line_id") {
  return picks.map((pick, index) => {
    const line = rows.find((entry) => String(entry.id) === pick.quotationLineId)!;
    const out = priced.lines[index];
    return {
      line_no: index + 1, [sourceKey]: pick.quotationLineId, variant_id: line.variant_id, unit_id: line.unit_id, product_name: line.product_name, variant_name: line.variant_name,
      sku: line.sku, unit_name: line.unit_name, hs_code: line.hs_code, qty_entered: formatQuantity(pick.quantityMilli), factor_to_base: quantityText(String(line.factor_to_base)),
      qty_base: formatQuantity((pick.quantityMilli * parseQuantity(String(line.factor_to_base))) / 1000), unit_price_paisa: paisa(line.unit_price_paisa), gross_paisa: out.grossPaisa,
      line_discount_paisa: out.lineDiscountPaisa, invoice_discount_share_paisa: out.invoiceDiscountSharePaisa, net_paisa: out.netPaisa, tax_rate_bps: Number(line.tax_rate_bps),
      tax_included: taxMode === "inclusive", taxable_paisa: out.taxablePaisa, tax_paisa: out.taxPaisa, total_paisa: out.totalPaisa,
    };
  });
}

const amountsOf = (priced: ReturnType<typeof priceConversion>) => ({
  gross_paisa: priced.grossPaisa, line_discount_paisa: priced.lineDiscountPaisa, invoice_discount_paisa: priced.invoiceDiscountPaisa, taxable_paisa: priced.taxablePaisa,
  tax_paisa: priced.taxPaisa, rounding_paisa: priced.roundingPaisa, total_paisa: priced.totalPaisa,
});

const quotedLine = (line: Row): QuotedLine => ({
  id: String(line.id), quantity: quantityText(String(line.qty_entered)), unitPricePaisa: paisa(line.unit_price_paisa), lineDiscountPaisa: paisa(line.line_discount_paisa), taxRateBps: Number(line.tax_rate_bps),
});

/** Picks the caller named, or everything that can still be billed; each is checked against what is left. */
function choosePicks(context: Context, rows: Row[], input: SalesInvoiceInput, leftMilli: (line: Row) => number, errorCode: "BILLING_EXCEEDS_DELIVERY" | "CONVERSION_EXCEEDS_QUOTATION"): { picks: ConversionPick[] } | { response: Response } {
  const picks: ConversionPick[] = input.picks
    ? input.picks.map((pick) => ({ quotationLineId: pick.lineId, quantityMilli: parseQuantity(pick.quantity) }))
    : rows.filter((line) => leftMilli(line) > 0).map((line) => ({ quotationLineId: String(line.id), quantityMilli: leftMilli(line) }));
  if (!picks.length) return { response: apiError(context, 409, errorCode, errorCode === "BILLING_EXCEEDS_DELIVERY" ? "Nothing delivered is waiting to be billed on this order" : "Everything on this quotation has already been ordered or billed") };
  const seen = new Set<string>();
  for (const pick of picks) {
    const line = rows.find((entry) => String(entry.id) === pick.quotationLineId);
    if (!line) return { response: apiError(context, 422, "INVALID_LINE", "A line is not on this document") };
    if (seen.has(pick.quotationLineId)) return { response: apiError(context, 422, "INVALID_LINE", "A line can be named once") };
    seen.add(pick.quotationLineId);
    if (pick.quantityMilli > leftMilli(line)) {
      return { response: apiError(context, 409, errorCode, `${line.sku}: ${formatQuantity(leftMilli(line))} can be billed, ${formatQuantity(pick.quantityMilli)} asked for`) };
    }
  }
  return { picks };
}

async function prepare(context: Context, businessId: string, input: SalesInvoiceInput): Promise<{ response: Response } | { prepared: Prepared }> {
  const principal = getPrincipal(context);

  if (input.orderId) {
    const [order] = await db.execute(sql`select * from sales_orders where id = ${input.orderId} and business_id = ${businessId}`);
    if (!order) return { response: apiError(context, 404, "NOT_FOUND", "Sales order not found") };
    if (input.customerId && input.customerId !== String(order.customer_id)) return { response: apiError(context, 422, "INVALID_CUSTOMER", "The invoice must be for the customer the order is for") };
    const rows = await db.execute(sql`select * from sales_order_lines where order_id = ${input.orderId} and business_id = ${businessId} order by line_no`);
    // Only goods that have gone out can be billed: delivered less billed, in the unit the line was ordered in.
    const leftMilli = (line: Row) => Math.floor(((parseQuantity(String(line.delivered_base)) - parseQuantity(String(line.invoiced_base))) * 1000) / parseQuantity(String(line.factor_to_base)));
    const chosen = choosePicks(context, rows, input, leftMilli, "BILLING_EXCEEDS_DELIVERY");
    if ("response" in chosen) return chosen;
    const taxMode = String(order.tax_mode) as "inclusive" | "exclusive";
    const priced = priceConversion({ taxMode, lines: rows.map(quotedLine), invoiceDiscountPaisa: paisa(order.invoice_discount_paisa), picks: chosen.picks });
    return { prepared: { customerId: String(order.customer_id), branchId: String(order.branch_id), locationId: String(order.location_id), taxMode, amounts: amountsOf(priced), lines: linesFromSource(rows, chosen.picks, priced, taxMode, "order_line_id"), orderId: input.orderId } };
  }

  if (input.quotationId) {
    const [quote] = await db.execute(sql`select * from quotations where id = ${input.quotationId} and business_id = ${businessId}`);
    if (!quote) return { response: apiError(context, 404, "NOT_FOUND", "Quotation not found") };
    const customerId = quote.customer_id ? String(quote.customer_id) : input.customerId ?? null;
    if (!customerId) return { response: apiError(context, 422, "CUSTOMER_REQUIRED", "This quotation is for a prospect. Choose the customer the invoice is for.") };
    if (quote.customer_id && input.customerId && input.customerId !== String(quote.customer_id)) return { response: apiError(context, 422, "INVALID_CUSTOMER", "The invoice must be for the customer the quotation was written for") };
    const rows = await db.execute(sql`select * from quotation_lines where quotation_id = ${input.quotationId} and business_id = ${businessId} order by line_no`);
    const leftMilli = (line: Row) => Math.floor(((parseQuantity(String(line.qty_base)) - parseQuantity(String(line.converted_base))) * 1000) / parseQuantity(String(line.factor_to_base)));
    const chosen = choosePicks(context, rows, input, leftMilli, "CONVERSION_EXCEEDS_QUOTATION");
    if ("response" in chosen) return chosen;
    const branchId = await resolveBranchId(businessId, input.branchId ?? String(quote.branch_id), null);
    const locationId = branchId ? await resolveOrderLocationId(businessId, branchId, input.locationId) : null;
    if (!branchId || !locationId) return { response: apiError(context, 422, "INVALID_LOCATION", "There is no store location to take the stock from") };
    const taxMode = String(quote.tax_mode) as "inclusive" | "exclusive";
    const priced = priceConversion({ taxMode, lines: rows.map(quotedLine), invoiceDiscountPaisa: paisa(quote.invoice_discount_paisa), picks: chosen.picks });
    return { prepared: { customerId, branchId, locationId, taxMode, amounts: amountsOf(priced), lines: linesFromSource(rows, chosen.picks, priced, taxMode, "quotation_line_id"), quotationId: input.quotationId } };
  }

  const branchId = await resolveBranchId(businessId, input.branchId, principal.terminalId);
  const locationId = branchId ? await resolveOrderLocationId(businessId, branchId, input.locationId) : null;
  if (!branchId || !locationId) return { response: apiError(context, 422, "INVALID_LOCATION", "There is no store location to take the stock from") };
  const result = await priceDocument(context, principal, { customerId: input.customerId, lines: input.lines!, invoiceDiscount: input.invoiceDiscount });
  if ("response" in result) return result;
  const { priced } = result;
  return { prepared: { customerId: priced.customerId!, branchId, locationId, taxMode: priced.taxMode, amounts: priced.amounts, lines: priced.lines } };
}

salesInvoiceRoutes.post("/sales-invoices", create, idempotent(), validateJson(salesInvoiceSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input: SalesInvoiceInput = context.req.valid("json");

  const made = await prepare(context, businessId, input);
  if ("response" in made) return made.response;
  const { prepared } = made;
  const [customer] = await db.select().from(customers).where(eq(customers.id, prepared.customerId)).limit(1);
  if (!customer || customer.businessId !== businessId || !customer.active) return apiError(context, 422, "INVALID_CUSTOMER", "This customer is not available");
  const [settings] = await db.select({ allowNegativeStock: businessSettings.allowNegativeStock }).from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1);

  const payload = {
    business_id: businessId, branch_id: prepared.branchId, location_id: prepared.locationId, customer_id: prepared.customerId, order_id: prepared.orderId ?? null, quotation_id: prepared.quotationId ?? null,
    allow_negative_stock: settings?.allowNegativeStock ?? false, tax_mode: prepared.taxMode, ...prepared.amounts,
    // Someone allowed to approve credit stands behind an invoice that goes over the limit or to an overdue customer.
    credit_approved_by: hasPermission(principal, "sales.credit_override") ? getActorId(principal) : null,
    terms_days: input.termsDays ?? customer.termsDays, due_date: input.dueDate ?? null, customer_po: input.customerPo ?? "", note: input.note ?? "", lines: prepared.lines,
  };

  const fbrProblems = await fbrPreflight(businessId, { terminalId: null, customerId: prepared.customerId, totalPaisa: prepared.amounts.total_paisa, lines: prepared.lines as Array<Record<string, unknown>> });
  if (fbrProblems.length) return apiError(context, 422, "FBR_INCOMPLETE", `FBR needs more detail before this can be posted. ${fbrProblems.slice(0, 5).join(". ")}${fbrProblems.length > 5 ? `. And ${fbrProblems.length - 5} more` : ""}.`);
  let invoiceId: string;
  let fbrQueued: string | null = null;
  try {
    invoiceId = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select post_back_office_invoice(${JSON.stringify(payload)}::jsonb, ${getActorId(principal)}) as id`);
      fbrQueued = await queueFbrSubmission(tx, businessId, "sales_invoice", row.id, null);
      return row.id;
    });
  } catch (error) {
    const message = dbErrorMessage(error);
    if (message.includes("STOCK_INSUFFICIENT")) return apiError(context, 409, "STOCK_INSUFFICIENT", await describeShortage(businessId, message));
    const credit = /CREDIT_LIMIT_EXCEEDED|CUSTOMER_OVERDUE/.exec(message)?.[0];
    if (credit) return apiError(context, 409, credit, describeCredit(credit, message, customer.name));
    const known = functionErrors.find(([prefix]) => message.includes(prefix));
    if (known) return apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message);
    throw error;
  }

  await auditPrincipal(context, principal, "sales_invoice", invoiceId, "post", null, { totalPaisa: prepared.amounts.total_paisa, lines: prepared.lines.length, orderId: prepared.orderId, quotationId: prepared.quotationId });
  await reportNow(fbrQueued);
  return context.json({ invoice: await loadInvoice(businessId, invoiceId, canSeeCost(principal)) }, 201);
});

/** Back-office invoices, newest first. `status`: open (something still owing), overdue (owing past the due date) or paid. */
salesInvoiceRoutes.get("/sales-invoices", view, async (context) => {
  const principal = getPrincipal(context);
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const status = context.req.query("status") ?? "";
  const customerId = context.req.query("customerId");
  const orderId = context.req.query("orderId");
  const search = context.req.query("q")?.trim();
  const filters = [sql`i.business_id = ${principal.businessId!}`, sql`i.channel = 'back_office'`];
  const outstanding = sql`(i.balance_paisa - coalesce(a.allocated, 0))`;
  if (status === "open") filters.push(sql`${outstanding} > 0`);
  if (status === "paid") filters.push(sql`${outstanding} = 0`);
  if (status === "overdue") filters.push(sql`${outstanding} > 0 and i.due_date < (now() at time zone 'Asia/Karachi')::date`);
  if (customerId && /^[0-9a-f-]{36}$/i.test(customerId)) filters.push(sql`i.customer_id = ${customerId}`);
  if (orderId && /^[0-9a-f-]{36}$/i.test(orderId)) filters.push(sql`i.order_id = ${orderId}`);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    filters.push(sql`(i.number ilike ${pattern} or c.name ilike ${pattern} or i.customer_po ilike ${pattern})`);
  }
  const rows = await db.execute(sql`
    select i.id, i.number, i.posted_at, i.due_date, i.terms_days, i.total_paisa, ${outstanding} as outstanding_paisa, i.customer_po, c.name as customer_name, o.number as order_number,
           (${outstanding} > 0 and i.due_date < (now() at time zone 'Asia/Karachi')::date) as overdue, count(*) over () as total
    from sales_invoices i join customers c on c.id = i.customer_id left join sales_orders o on o.id = i.order_id
    left join lateral (select sum(x.amount_paisa) as allocated from payment_allocations x where x.invoice_id = i.id) a on true
    where ${sql.join(filters, sql` and `)}
    order by i.posted_at desc, i.id limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id), number: String(row.number), postedAt: iso(row.posted_at), dueDate: day(row.due_date), termsDays: row.terms_days === null ? null : Number(row.terms_days),
      totalPaisa: paisa(row.total_paisa), outstandingPaisa: paisa(row.outstanding_paisa), overdue: Boolean(row.overdue), customerPo: String(row.customer_po), customerName: String(row.customer_name),
      orderNumber: row.order_number ? String(row.order_number) : null,
    })),
    page, pageSize, total: rows.length ? paisa(rows[0].total) : 0,
  });
});

salesInvoiceRoutes.get("/sales-invoices/:id", view, async (context) => {
  const principal = getPrincipal(context);
  const invoice = await loadInvoice(principal.businessId!, paramId(context), canSeeCost(principal));
  if (!invoice || invoice.channel !== "back_office") return apiError(context, 404, "NOT_FOUND", "Invoice not found");
  // What is still owing, after any payments received since.
  const [row] = await db.execute(sql`
    select i.balance_paisa - coalesce((select sum(x.amount_paisa) from payment_allocations x where x.invoice_id = i.id), 0) as outstanding
    from sales_invoices i where i.id = ${invoice.id}`);
  return context.json({ ...invoice, outstandingPaisa: paisa(row.outstanding) });
});
