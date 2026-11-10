import { and, asc, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { branches, businessSettings, customerGroups, customers, priceListItems, priceLists, roles, terminals } from "../../../db/schema";
import { effectivePriceListId, tierPrice, type PriceListItem } from "../../../shared/priceLists";
import { discountsOverLimit, priceCart, PricingError, type PricingInput } from "../../../shared/pricing";
import { quotationSchema, type QuotationInput } from "../../../shared/schemas/quotations";
import { formatQuantity, parseQuantity, toBaseQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, hasPermission, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { escapeLike, quantityText } from "../products/service";

// Quotations (FR-QUO-01..05). A quotation touches neither stock nor any ledger. Its prices are worked out here with the shared
// pricing code and stored on it, so a later price change does not move a quotation that was already given out.

export const quotationRoutes = new Hono();

const view = requirePermission("quotations.view");
const manage = requirePermission("quotations.manage");
const paisa = (value: unknown) => Number(value);
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);

const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});

/** A sent quotation whose validity date has passed reads as expired. Nothing is stored: no job has to run at midnight. */
const effectiveStatus = sql`case when q.status = 'sent' and q.valid_until < (now() at time zone 'Asia/Karachi')::date then 'expired' else q.status end`;

const functionErrors: Array<[prefix: string, status: 404 | 409 | 422, code: string]> = [
  ["NOT_FOUND", 404, "NOT_FOUND"],
  ["INVALID_CUSTOMER", 422, "INVALID_CUSTOMER"],
  ["INVALID_BRANCH", 422, "INVALID_BRANCH"],
  ["INVALID_DATE", 422, "INVALID_DATE"],
  ["INVALID_LINE", 422, "INVALID_LINE"],
  ["QUOTATION_NOT_EDITABLE", 409, "QUOTATION_NOT_EDITABLE"],
  ["QUOTATION_EXPIRED", 409, "QUOTATION_EXPIRED"],
  ["INVALID_TRANSITION", 409, "INVALID_TRANSITION"],
];
export function mapQuotationError(context: Context, error: unknown): Response | null {
  const message = dbErrorMessage(error);
  const known = functionErrors.find(([prefix]) => message.includes(prefix));
  return known ? apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message) : null;
}

export async function loadQuotation(businessId: string, id: string) {
  const [row] = await db.execute(sql`
    select q.*, ${effectiveStatus} as effective_status, c.name as customer_name, c.phone as customer_phone, c.ntn as customer_ntn, c.strn as customer_strn, b.name as branch_name
    from quotations q join branches b on b.id = q.branch_id left join customers c on c.id = q.customer_id
    where q.business_id = ${businessId} and q.id = ${id}`);
  if (!row) return null;
  const lines = await db.execute(sql`select * from quotation_lines where business_id = ${businessId} and quotation_id = ${id} order by line_no`);
  const revisions = await db.execute(sql`
    select q.id, q.revision_no, q.status, ${effectiveStatus} as effective_status, q.total_paisa, q.created_at
    from quotations q where q.business_id = ${businessId} and q.root_id = ${row.root_id} order by q.revision_no`);
  return {
    id: String(row.id), number: String(row.number), revisionNo: Number(row.revision_no), rootId: String(row.root_id),
    status: String(row.effective_status), storedStatus: String(row.status), supersededBy: row.superseded_by ? String(row.superseded_by) : null,
    branchId: String(row.branch_id), branchName: String(row.branch_name),
    customerId: row.customer_id ? String(row.customer_id) : null,
    // A prospect has only what was typed; a customer's details are read from the customer.
    customerName: row.customer_id ? String(row.customer_name) : String(row.prospect_name),
    customerPhone: row.customer_id ? String(row.customer_phone ?? "") : String(row.prospect_phone),
    customerNtn: row.customer_ntn ? String(row.customer_ntn) : null, customerStrn: row.customer_strn ? String(row.customer_strn) : null,
    isProspect: !row.customer_id,
    quoteDate: day(row.quote_date), validUntil: day(row.valid_until), terms: String(row.terms), note: String(row.note), taxMode: String(row.tax_mode),
    grossPaisa: paisa(row.gross_paisa), lineDiscountPaisa: paisa(row.line_discount_paisa), invoiceDiscountPaisa: paisa(row.invoice_discount_paisa),
    taxablePaisa: paisa(row.taxable_paisa), taxPaisa: paisa(row.tax_paisa), roundingPaisa: paisa(row.rounding_paisa), totalPaisa: paisa(row.total_paisa),
    createdAt: iso(row.created_at),
    lines: lines.map((line) => ({
      id: String(line.id), lineNo: Number(line.line_no), variantId: String(line.variant_id), unitId: String(line.unit_id), productName: String(line.product_name),
      variantName: String(line.variant_name), sku: String(line.sku), unitName: String(line.unit_name), hsCode: line.hs_code ? String(line.hs_code) : null,
      quantity: quantityText(String(line.qty_entered)), factorToBase: quantityText(String(line.factor_to_base)), qtyBase: quantityText(String(line.qty_base)),
      convertedBase: quantityText(String(line.converted_base)),
      unitPricePaisa: paisa(line.unit_price_paisa), grossPaisa: paisa(line.gross_paisa), lineDiscountPaisa: paisa(line.line_discount_paisa),
      invoiceDiscountSharePaisa: paisa(line.invoice_discount_share_paisa), netPaisa: paisa(line.net_paisa), taxRateBps: Number(line.tax_rate_bps),
      taxPaisa: paisa(line.tax_paisa), totalPaisa: paisa(line.total_paisa),
    })),
    revisions: revisions.map((revision) => ({
      id: String(revision.id), revisionNo: Number(revision.revision_no), status: String(revision.effective_status), totalPaisa: paisa(revision.total_paisa), createdAt: iso(revision.created_at),
    })),
  };
}

quotationRoutes.get("/quotations", view, async (context) => {
  const principal = getPrincipal(context);
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const status = context.req.query("status") ?? "";
  const customerId = context.req.query("customerId");
  const search = context.req.query("q")?.trim();
  const filters = [sql`q.business_id = ${principal.businessId!}`];
  if (["draft", "sent", "accepted", "rejected", "converted", "revised", "expired"].includes(status)) filters.push(sql`${effectiveStatus} = ${status}`);
  // "Open" is what still needs an answer; a superseded revision is history and stays out of the working list unless asked for.
  if (status === "open") filters.push(sql`${effectiveStatus} in ('draft', 'sent', 'accepted')`);
  if (!status) filters.push(sql`q.status <> 'revised'`);
  if (customerId && /^[0-9a-f-]{36}$/i.test(customerId)) filters.push(sql`q.customer_id = ${customerId}`);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    filters.push(sql`(q.number ilike ${pattern} or q.prospect_name ilike ${pattern} or c.name ilike ${pattern})`);
  }
  const rows = await db.execute(sql`
    select q.id, q.number, q.revision_no, ${effectiveStatus} as effective_status, q.quote_date, q.valid_until, q.total_paisa, q.customer_id,
           coalesce(c.name, q.prospect_name) as customer_name, count(*) over () as total
    from quotations q left join customers c on c.id = q.customer_id
    where ${sql.join(filters, sql` and `)}
    order by q.quote_date desc, q.number desc, q.revision_no desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id), number: String(row.number), revisionNo: Number(row.revision_no), status: String(row.effective_status), quoteDate: day(row.quote_date),
      validUntil: day(row.valid_until), totalPaisa: paisa(row.total_paisa), customerId: row.customer_id ? String(row.customer_id) : null, customerName: String(row.customer_name),
    })),
    page, pageSize, total: rows.length ? paisa(rows[0].total) : 0,
  });
});

quotationRoutes.get("/quotations/:id", view, async (context) => {
  const found = await loadQuotation(getPrincipal(context).businessId!, paramId(context));
  return found ? context.json(found) : apiError(context, 404, "NOT_FOUND", "Quotation not found");
});

type LineFacts = {
  variant_id: string; unit_id: string; product_name: string; variant_name: string; sku: string; unit_name: string; hs_code: string | null;
  factor_to_base: string; sale_price_paisa: string; rate_bps: number | null;
};

/** The branch a quotation belongs to: the one named, else the till's, else the first branch of the business. */
async function resolveBranchId(businessId: string, requested: string | undefined, terminalId: string | null): Promise<string | null> {
  if (requested) {
    const [branch] = await db.select({ id: branches.id }).from(branches).where(and(eq(branches.id, requested), eq(branches.businessId, businessId))).limit(1);
    return branch?.id ?? null;
  }
  if (terminalId) {
    const [terminal] = await db.select({ branchId: terminals.branchId }).from(terminals).where(and(eq(terminals.id, terminalId), eq(terminals.businessId, businessId))).limit(1);
    if (terminal) return terminal.branchId;
  }
  const [first] = await db.select({ id: branches.id }).from(branches).where(eq(branches.businessId, businessId)).orderBy(asc(branches.createdAt)).limit(1);
  return first?.id ?? null;
}

async function saveQuotation(context: Context, input: QuotationInput, id?: string) {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const parsed = quotationSchema.parse(input);

  const branchId = await resolveBranchId(businessId, parsed.branchId, principal.terminalId);
  if (!branchId) return apiError(context, 422, "INVALID_BRANCH", "This branch is not available");
  const [settings] = await db.select().from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1);
  if (!settings) return apiError(context, 409, "SETTINGS_MISSING", "The business settings are missing");

  const keys = parsed.lines.map((line) => sql`(${line.variantId}::uuid, ${line.unitId}::uuid)`);
  const facts = await db.execute<LineFacts>(sql`
    select v.id as variant_id, pu.unit_id, p.name as product_name, v.variant_name, v.sku, u.name as unit_name, p.hs_code,
           pu.factor_to_base::text, pu.sale_price_paisa::text, tc.rate_bps
    from product_units pu
    join product_variants v on v.id = pu.variant_id and v.business_id = pu.business_id and v.active
    join products p on p.id = v.product_id and p.active
    join units u on u.id = pu.unit_id
    left join tax_categories tc on tc.id = p.tax_category_id
    where pu.business_id = ${businessId} and (pu.variant_id, pu.unit_id) in (${sql.join(keys, sql`, `)})
  `);
  const factsOf = (variantId: string, unitId: string) => facts.find((row) => row.variant_id === variantId && row.unit_id === unitId);
  const missing = parsed.lines.findIndex((line) => !factsOf(line.variantId, line.unitId));
  if (missing >= 0) return apiError(context, 422, "INVALID_LINE", `Line ${missing + 1} is not an active product sold in that unit`);

  // A registered customer is quoted at their tier: their own price list, else their group's.
  let customerId: string | null = null;
  let tierItems: PriceListItem[] = [];
  if (parsed.customerId) {
    const [customer] = await db.select().from(customers).where(and(eq(customers.id, parsed.customerId), eq(customers.businessId, businessId), eq(customers.active, true))).limit(1);
    if (!customer) return apiError(context, 422, "INVALID_CUSTOMER", "This customer is not available");
    customerId = customer.id;
    const [group] = customer.groupId ? await db.select().from(customerGroups).where(eq(customerGroups.id, customer.groupId)).limit(1) : [];
    const listId = effectivePriceListId(customer, group);
    if (listId) {
      const rows = await db.select({ variantId: priceListItems.variantId, unitId: priceListItems.unitId, min: priceListItems.minQuantity, price: priceListItems.pricePaisa })
        .from(priceListItems).innerJoin(priceLists, eq(priceLists.id, priceListItems.priceListId))
        .where(and(eq(priceListItems.priceListId, listId), eq(priceListItems.businessId, businessId), eq(priceLists.active, true)));
      tierItems = rows.map((row) => ({ variantId: row.variantId, unitId: row.unitId, minQuantityMilli: parseQuantity(quantityText(row.min)), pricePaisa: row.price }));
    }
  }

  const mayOverridePrice = hasPermission(principal, "sales.price_override");
  const pricingInput: PricingInput = { taxMode: settings.taxMode, cashRounding: 0, invoiceDiscount: parsed.invoiceDiscount ?? null, lines: [] };
  for (const [index, line] of parsed.lines.entries()) {
    const fact = factsOf(line.variantId, line.unitId)!;
    const qtyMilli = parseQuantity(line.quantity);
    const shelfPrice = tierPrice(tierItems, line.variantId, line.unitId, qtyMilli) ?? Number(fact.sale_price_paisa);
    if (line.unitPricePaisa !== undefined && line.unitPricePaisa !== shelfPrice && !mayOverridePrice) {
      return apiError(context, 403, "PRICE_OVERRIDE_DENIED", `Line ${index + 1}: you may not change the price`);
    }
    pricingInput.lines.push({ qtyMilli, unitPricePaisa: line.unitPricePaisa ?? shelfPrice, taxRateBps: fact.rate_bps ?? 0, discount: line.discount ?? null });
  }
  let priced;
  try {
    priced = priceCart(pricingInput);
  } catch (error) {
    if (error instanceof PricingError) return apiError(context, 422, error.code, error.message);
    throw error;
  }

  // Discounts follow the same limits as at the till; there is no manager PIN here, so above the limit it is refused.
  const hasDiscount = Boolean(parsed.invoiceDiscount) || parsed.lines.some((line) => line.discount);
  if (hasDiscount) {
    if (!hasPermission(principal, "sales.discount")) return apiError(context, 403, "DISCOUNT_DENIED", "You may not give discounts");
    if (!hasPermission(principal, "sales.discount.above_limit")) {
      const [role] = await db.select({ limit: roles.maxDiscountBps }).from(roles).where(eq(roles.id, principal.roleId!)).limit(1);
      if (discountsOverLimit(pricingInput, priced, role?.limit ?? 0).length) {
        return apiError(context, 403, "DISCOUNT_APPROVAL_REQUIRED", "This discount is more than you may give");
      }
    }
  }

  const payload = {
    business_id: businessId, id, branch_id: branchId, customer_id: customerId, prospect_name: customerId ? "" : parsed.prospectName, prospect_phone: parsed.prospectPhone,
    quote_date: parsed.quoteDate ?? null, valid_until: parsed.validUntil, terms: parsed.terms, note: parsed.note, tax_mode: settings.taxMode,
    gross_paisa: priced.grossPaisa, line_discount_paisa: priced.lineDiscountPaisa, invoice_discount_paisa: priced.invoiceDiscountPaisa,
    taxable_paisa: priced.taxablePaisa, tax_paisa: priced.taxPaisa, rounding_paisa: priced.roundingPaisa, total_paisa: priced.totalPaisa,
    lines: parsed.lines.map((line, index) => {
      const fact = factsOf(line.variantId, line.unitId)!;
      const entered = parseQuantity(line.quantity);
      const base = toBaseQuantity(entered, parseQuantity(quantityText(fact.factor_to_base)));
      const priceLine = pricingInput.lines[index];
      const out = priced.lines[index];
      return {
        line_no: index + 1, variant_id: line.variantId, unit_id: line.unitId, product_name: fact.product_name, variant_name: fact.variant_name, sku: fact.sku,
        unit_name: fact.unit_name, hs_code: fact.hs_code, qty_entered: formatQuantity(entered), factor_to_base: quantityText(fact.factor_to_base), qty_base: formatQuantity(base),
        unit_price_paisa: priceLine.unitPricePaisa, gross_paisa: out.grossPaisa, line_discount_paisa: out.lineDiscountPaisa, invoice_discount_share_paisa: out.invoiceDiscountSharePaisa,
        net_paisa: out.netPaisa, tax_rate_bps: priceLine.taxRateBps, tax_included: settings.taxMode === "inclusive", taxable_paisa: out.taxablePaisa, tax_paisa: out.taxPaisa,
        total_paisa: out.totalPaisa,
      };
    }),
  };

  let savedId: string;
  try {
    savedId = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select save_quotation(${JSON.stringify(payload)}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const mapped = mapQuotationError(context, error);
    if (mapped) return mapped;
    throw error;
  }
  await auditPrincipal(context, principal, "quotation", savedId, id ? "update" : "create", null, { totalPaisa: priced.totalPaisa, lines: parsed.lines.length });
  return context.json(await loadQuotation(businessId, savedId), id ? 200 : 201);
}

quotationRoutes.post("/quotations", manage, validateJson(quotationSchema), (context) => saveQuotation(context, context.req.valid("json")));
quotationRoutes.put("/quotations/:id", manage, validateJson(quotationSchema), (context) => saveQuotation(context, context.req.valid("json"), paramId(context)));

async function moveQuotation(context: Context, action: "send" | "accept" | "reject", status: "sent" | "accepted" | "rejected") {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_quotation_status(${businessId}::uuid, ${id}::uuid, ${status}, ${getActorId(principal)})`);
    });
  } catch (error) {
    const mapped = mapQuotationError(context, error);
    if (mapped) return mapped;
    throw error;
  }
  await auditPrincipal(context, principal, "quotation", id, action, null, { status });
  return context.json(await loadQuotation(businessId, id));
}

quotationRoutes.post("/quotations/:id/send", manage, idempotent(), (context) => moveQuotation(context, "send", "sent"));
quotationRoutes.post("/quotations/:id/accept", manage, idempotent(), (context) => moveQuotation(context, "accept", "accepted"));
quotationRoutes.post("/quotations/:id/reject", manage, idempotent(), (context) => moveQuotation(context, "reject", "rejected"));

/** Starts the next revision (FR-QUO-05): a draft copy with the same number, the old one kept as history. */
quotationRoutes.post("/quotations/:id/revise", manage, idempotent(), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  let revisionId: string;
  try {
    revisionId = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select revise_quotation(${businessId}::uuid, ${id}::uuid, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const mapped = mapQuotationError(context, error);
    if (mapped) return mapped;
    throw error;
  }
  await auditPrincipal(context, principal, "quotation", id, "revise", null, { revisionId });
  return context.json(await loadQuotation(businessId, revisionId), 201);
});
