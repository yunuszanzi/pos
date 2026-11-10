import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { auditLog, businessSettings, customers, terminals } from "../../../db/schema";
import { isOutsideReturnWindow, priceReturn, remainingToReturn, returnedBaseQuantity, ReturnError, type SoldLine } from "../../../shared/returns";
import { priceCart, PricingError } from "../../../shared/pricing";
import { postReturnSchema } from "../../../shared/schemas/returns";
import { formatQuantity, parseQuantity, toBaseQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { queueFbrSubmission, reportNow } from "../../fbr/service";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, hasPermission, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { approveByManager } from "../sales/approval";
import { resolveSalesLocationId } from "../sales/location";
import { escapeLike, quantityText } from "../products/service";

// Taking goods back: a return against an invoice (or, with a manager's approval, without one), the refund, and the credit note
// (FR-RET-01..07). The invoice is never edited; the return is a new document that points at it.

export const returnRoutes = new Hono();

const paisa = (value: unknown) => Number(value);
const useReturns = requirePermission("sales.return");

/** Rule violations raised by the posting function, as the status and code the till understands. */
const returnErrors: Array<[prefix: string, status: 404 | 409 | 422, code: string, message?: string]> = [
  ["SHIFT_NOT_OPEN", 409, "SHIFT_NOT_OPEN"],
  ["RETURN_CHANGED", 409, "RETURN_CHANGED", "This invoice was returned against while you were working. Open the return again."],
  ["RETURN_EXCEEDS_SOLD", 409, "RETURN_EXCEEDS_SOLD", "More is being returned than was sold on this invoice"],
  ["INVALID_LINE", 422, "INVALID_LINE"],
  ["INVALID_CUSTOMER", 422, "INVALID_CUSTOMER"],
  ["INVALID_REFUND", 422, "INVALID_REFUND"],
  ["INVALID_RETURN", 404, "NOT_FOUND"],
  ["RETURN_TOTAL_MISMATCH", 422, "RETURN_TOTAL_MISMATCH"],
];

type InvoiceLine = {
  id: string; line_no: number; variant_id: string; unit_id: string; product_name: string; variant_name: string; sku: string; unit_name: string;
  qty_entered: string; factor_to_base: string; qty_base: string; returned_qty_base: string; unit_price_paisa: string; gross_paisa: string;
  line_discount_paisa: string; invoice_discount_share_paisa: string; tax_paisa: string; total_paisa: string; tax_rate_bps: number; tax_included: boolean;
};

async function loadSoldInvoice(businessId: string, invoiceId: string) {
  const [invoice] = await db.execute<{ id: string; number: string; posted_at: Date; customer_id: string | null; customer_name: string | null; tax_mode: string; rounding_paisa: string; total_paisa: string }>(sql`
    select i.id, i.number, i.posted_at, i.customer_id, c.name as customer_name, i.tax_mode, i.rounding_paisa::text, i.total_paisa::text
    from sales_invoices i left join customers c on c.id = i.customer_id
    where i.business_id = ${businessId} and i.id = ${invoiceId}
  `);
  if (!invoice) return null;
  const lines = await db.execute<InvoiceLine>(sql`
    select id, line_no, variant_id, unit_id, product_name, variant_name, sku, unit_name, qty_entered::text, factor_to_base::text, qty_base::text,
           returned_qty_base::text, unit_price_paisa::text, gross_paisa::text, line_discount_paisa::text, invoice_discount_share_paisa::text,
           tax_paisa::text, total_paisa::text, tax_rate_bps, tax_included
    from sales_invoice_lines where business_id = ${businessId} and invoice_id = ${invoiceId} order by line_no
  `);
  return { invoice, lines };
}

const milli = (text: string) => parseQuantity(quantityText(text));

const soldLineOf = (line: InvoiceLine): SoldLine => ({
  id: line.id, qtyBase: milli(line.qty_base), returnedBase: milli(line.returned_qty_base), grossPaisa: paisa(line.gross_paisa),
  lineDiscountPaisa: paisa(line.line_discount_paisa), invoiceDiscountSharePaisa: paisa(line.invoice_discount_share_paisa),
  taxPaisa: paisa(line.tax_paisa), totalPaisa: paisa(line.total_paisa), taxIncluded: line.tax_included,
});

async function returnWindowDays(businessId: string) {
  const [settings] = await db.select({ days: businessSettings.returnWindowDays }).from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1);
  return settings?.days ?? 14;
}

/** What can still be returned on an invoice, for the screen that picks the items. */
returnRoutes.get("/sales/:id/returnable", useReturns, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const sold = await loadSoldInvoice(businessId, paramId(context));
  if (!sold) return apiError(context, 404, "NOT_FOUND", "Sale not found");
  const { invoice, lines } = sold;
  const days = await returnWindowDays(businessId);
  const [owed] = invoice.customer_id
    ? await db.execute<{ outstanding: string }>(sql`select coalesce(max(outstanding_paisa), 0)::text as outstanding from customer_open_invoices(${businessId}::uuid, ${invoice.customer_id}::uuid) where invoice_id = ${invoice.id}`)
    : [{ outstanding: "0" }];
  return context.json({
    invoice: { id: invoice.id, number: invoice.number, postedAt: invoice.posted_at, customerId: invoice.customer_id, customerName: invoice.customer_name, taxMode: invoice.tax_mode, roundingPaisa: paisa(invoice.rounding_paisa) },
    windowDays: days,
    outsideWindow: isOutsideReturnWindow(new Date(invoice.posted_at), new Date(), days),
    // What the customer still owes on this invoice: the return pays that off before anything is handed back.
    owedPaisa: paisa(owed.outstanding),
    lines: lines.map((line) => ({
      lineId: line.id, lineNo: line.line_no, productName: line.product_name, variantName: line.variant_name, sku: line.sku, unitName: line.unit_name,
      quantity: quantityText(line.qty_entered), returnedQuantity: formatQuantity(Math.round((milli(line.returned_qty_base) * 1000) / milli(line.factor_to_base))),
      remainingQuantity: formatQuantity(remainingToReturn(soldLineOf(line), milli(line.factor_to_base))), unitPricePaisa: paisa(line.unit_price_paisa), totalPaisa: paisa(line.total_paisa),
      // What the screen needs to show what a part-return is worth before it is posted (shared/returns.ts does the sums).
      factorToBase: quantityText(line.factor_to_base), qtyBase: quantityText(line.qty_base), returnedBase: quantityText(line.returned_qty_base),
      grossPaisa: paisa(line.gross_paisa), lineDiscountPaisa: paisa(line.line_discount_paisa), invoiceDiscountSharePaisa: paisa(line.invoice_discount_share_paisa),
      taxPaisa: paisa(line.tax_paisa), taxIncluded: line.tax_included,
    })),
  });
});

returnRoutes.post("/returns", useReturns, idempotent(), validateJson(postReturnSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const actor = getActorId(principal);
  const input = context.req.valid("json");

  if (!principal.terminalId) return apiError(context, 400, "TERMINAL_REQUIRED", "Returns are taken on a registered terminal");
  const [terminal] = await db.select().from(terminals)
    .where(and(eq(terminals.id, principal.terminalId), eq(terminals.businessId, businessId), eq(terminals.active, true))).limit(1);
  if (!terminal) return apiError(context, 400, "TERMINAL_REQUIRED", "Returns are taken on a registered terminal");
  const locationId = await resolveSalesLocationId(terminal);
  if (!locationId) return apiError(context, 409, "NO_SALES_LOCATION", "This branch has no store location to put returned goods in");
  const [settings] = await db.select().from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1);
  if (!settings) return apiError(context, 409, "SETTINGS_MISSING", "The business settings are missing");

  let approvalNeeded: string | null = null;
  let customerId: string | null = null;
  let lines: Array<Record<string, unknown>>;
  let totals: { grossPaisa: number; lineDiscountPaisa: number; invoiceDiscountPaisa: number; taxablePaisa: number; taxPaisa: number; roundingPaisa: number; totalPaisa: number };
  let taxMode: string = settings.taxMode;

  if (input.invoiceId) {
    const sold = await loadSoldInvoice(businessId, input.invoiceId);
    if (!sold) return apiError(context, 404, "NOT_FOUND", "Sale not found");
    const { invoice, lines: invoiceLines } = sold;
    customerId = invoice.customer_id;
    taxMode = invoice.tax_mode;
    if (isOutsideReturnWindow(new Date(invoice.posted_at), new Date(), settings.returnWindowDays)) {
      approvalNeeded = `Returned after the ${settings.returnWindowDays}-day window`;
    }
    const returning = [];
    for (const [index, line] of input.lines.entries()) {
      const original = invoiceLines.find((candidate) => candidate.id === line.originalLineId);
      if (!original) return apiError(context, 422, "INVALID_LINE", `Line ${index + 1} is not on invoice ${invoice.number}`);
      returning.push({ lineId: original.id, qtyBase: returnedBaseQuantity(soldLineOf(original), milli(original.factor_to_base), parseQuantity(line.quantity)) });
    }
    let priced;
    try {
      priced = priceReturn({ lines: invoiceLines.map(soldLineOf), roundingPaisa: paisa(invoice.rounding_paisa), returning });
    } catch (error) {
      if (error instanceof ReturnError) return apiError(context, error.code === "EXCEEDS_SOLD" ? 409 : 422, error.code === "EXCEEDS_SOLD" ? "RETURN_EXCEEDS_SOLD" : "INVALID_LINE", error.message);
      throw error;
    }
    totals = priced;
    lines = input.lines.map((line, index) => {
      const original = invoiceLines.find((candidate) => candidate.id === line.originalLineId)!;
      const back = priced.lines.find((candidate) => candidate.lineId === original.id)!;
      return {
        line_no: index + 1, original_line_id: original.id, variant_id: original.variant_id, unit_id: original.unit_id, product_name: original.product_name,
        variant_name: original.variant_name, sku: original.sku, unit_name: original.unit_name, hs_code: null, qty_entered: formatQuantity(parseQuantity(line.quantity)),
        factor_to_base: quantityText(original.factor_to_base), qty_base: formatQuantity(back.qtyBase), expected_returned_base: quantityText(original.returned_qty_base),
        unit_price_paisa: paisa(original.unit_price_paisa), gross_paisa: back.grossPaisa, line_discount_paisa: back.lineDiscountPaisa,
        invoice_discount_share_paisa: back.invoiceDiscountSharePaisa, net_paisa: back.netPaisa, tax_rate_bps: original.tax_rate_bps, tax_included: original.tax_included,
        taxable_paisa: back.taxablePaisa, tax_paisa: back.taxPaisa, total_paisa: back.totalPaisa, restock_to: line.restockTo, reason: line.reason,
      };
    });
  } else {
    // No receipt: the goods come back at today's shelf price, and a manager must agree.
    approvalNeeded = "Returned without a receipt";
    if (input.customerId) {
      const [customer] = await db.select({ id: customers.id }).from(customers)
        .where(and(eq(customers.id, input.customerId), eq(customers.businessId, businessId), eq(customers.active, true))).limit(1);
      if (!customer) return apiError(context, 422, "INVALID_CUSTOMER", "This customer is not available");
      customerId = customer.id;
    }
    const keys = input.lines.map((line) => sql`(${line.variantId}::uuid, ${line.unitId}::uuid)`);
    const facts = await db.execute<{ variant_id: string; unit_id: string; product_name: string; variant_name: string; sku: string; unit_name: string; hs_code: string | null; factor_to_base: string; sale_price_paisa: string; rate_bps: number | null }>(sql`
      select v.id as variant_id, pu.unit_id, p.name as product_name, v.variant_name, v.sku, u.name as unit_name, p.hs_code,
             pu.factor_to_base::text, pu.sale_price_paisa::text, tc.rate_bps
      from product_units pu
      join product_variants v on v.id = pu.variant_id and v.business_id = pu.business_id and v.active
      join products p on p.id = v.product_id and p.active
      join units u on u.id = pu.unit_id
      left join tax_categories tc on tc.id = p.tax_category_id
      where pu.business_id = ${businessId} and (pu.variant_id, pu.unit_id) in (${sql.join(keys, sql`, `)})
    `);
    const factOf = (variantId?: string, unitId?: string) => facts.find((row) => row.variant_id === variantId && row.unit_id === unitId);
    const missing = input.lines.findIndex((line) => !factOf(line.variantId, line.unitId));
    if (missing >= 0) return apiError(context, 422, "INVALID_LINE", `Line ${missing + 1} is not an active product sold in that unit`);
    let priced;
    try {
      priced = priceCart({
        taxMode: settings.taxMode,
        lines: input.lines.map((line) => ({ qtyMilli: parseQuantity(line.quantity), unitPricePaisa: paisa(factOf(line.variantId, line.unitId)!.sale_price_paisa), taxRateBps: factOf(line.variantId, line.unitId)!.rate_bps ?? 0 })),
      });
    } catch (error) {
      if (error instanceof PricingError) return apiError(context, 422, error.code, error.message);
      throw error;
    }
    totals = priced;
    lines = input.lines.map((line, index) => {
      const fact = factOf(line.variantId, line.unitId)!;
      const entered = parseQuantity(line.quantity);
      const out = priced.lines[index];
      return {
        line_no: index + 1, original_line_id: null, variant_id: line.variantId, unit_id: line.unitId, product_name: fact.product_name, variant_name: fact.variant_name,
        sku: fact.sku, unit_name: fact.unit_name, hs_code: fact.hs_code, qty_entered: formatQuantity(entered), factor_to_base: quantityText(fact.factor_to_base),
        qty_base: formatQuantity(toBaseQuantity(entered, milli(fact.factor_to_base))), expected_returned_base: "0", unit_price_paisa: paisa(fact.sale_price_paisa),
        gross_paisa: out.grossPaisa, line_discount_paisa: 0, invoice_discount_share_paisa: 0, net_paisa: out.netPaisa, tax_rate_bps: fact.rate_bps ?? 0,
        tax_included: settings.taxMode === "inclusive", taxable_paisa: out.taxablePaisa, tax_paisa: out.taxPaisa, total_paisa: out.totalPaisa,
        restock_to: line.restockTo, reason: line.reason,
      };
    });
  }

  // A return outside the window, or with no receipt, needs a manager. Their approval is recorded on the credit note.
  let approvedBy: string | null = null;
  if (approvalNeeded) {
    if (!input.approval) return apiError(context, 403, "RETURN_APPROVAL_REQUIRED", `${approvalNeeded}. A manager must approve it.`);
    const manager = await approveByManager(businessId, terminal.branchId, input.approval.managerEmail, input.approval.pin, "sales.return_override");
    if (manager === "rate-limited") return apiError(context, 429, "RATE_LIMITED", "Too many PIN attempts. Wait 15 minutes and try again.");
    if (manager === "invalid") return apiError(context, 401, "INVALID_PIN", "Manager email or PIN is incorrect");
    if (manager === "not-allowed") return apiError(context, 403, "OVERRIDE_NOT_ALLOWED", "This manager cannot approve returns at this terminal");
    approvedBy = manager;
  }

  const payload = {
    business_id: businessId, branch_id: terminal.branchId, terminal_id: terminal.id, shift_id: input.shiftId, location_id: locationId,
    original_invoice_id: input.invoiceId ?? null, customer_id: customerId, reason: input.reason, tax_mode: taxMode,
    gross_paisa: totals.grossPaisa, line_discount_paisa: totals.lineDiscountPaisa, invoice_discount_paisa: totals.invoiceDiscountPaisa,
    taxable_paisa: totals.taxablePaisa, tax_paisa: totals.taxPaisa, rounding_paisa: totals.roundingPaisa, total_paisa: totals.totalPaisa,
    refund_method_id: input.refund.methodId ?? null, refund_reference: input.refund.reference,
    approved_by: approvedBy, approval_note: approvedBy ? approvalNeeded : null, lines,
  };

  let returnId: string;
  let fbrQueued: string | null = null;
  try {
    returnId = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select post_sales_return(${JSON.stringify(payload)}::jsonb, ${actor}) as id`);
      // A return is reported to FBR as a debit note against the invoice it takes back (FR-FBR-12).
      fbrQueued = await queueFbrSubmission(tx, businessId, "sales_return", row.id, terminal.id);
      return row.id;
    });
  } catch (error) {
    const message = dbErrorMessage(error);
    const known = returnErrors.find(([prefix]) => message.includes(prefix));
    if (known) return apiError(context, known[1], known[2], known[3] ?? (message.replace(/^[A-Z_]+:?\s*/, "") || message));
    throw error;
  }

  await auditPrincipal(context, principal, "sales_return", returnId, "post", null, { totalPaisa: totals.totalPaisa, lines: lines.length, invoiceId: input.invoiceId ?? null, approvedBy });
  await reportNow(fbrQueued);
  const note = await loadReturn(businessId, returnId);
  // The till updates its cached stock from this instead of asking again (technical-plan 5.7).
  const stock = await db.execute<{ variant_id: string; on_hand: string }>(sql`
    select variant_id, sum(on_hand)::text as on_hand from stock_balances
    where business_id = ${businessId} and location_id = ${locationId} and variant_id in (${sql.join([...new Set(lines.map((row) => row.variant_id as string))].map((id) => sql`${id}::uuid`), sql`, `)})
    group by variant_id
  `);
  return context.json({ creditNote: note, stock: stock.map((row) => ({ variantId: row.variant_id, onHand: quantityText(row.on_hand) })) }, 201);
});

async function loadReturn(businessId: string, id: string) {
  const [row] = await db.execute(sql`
    select r.*, b.name as branch_name, t.name as terminal_name, u.display_name as cashier_name, c.name as customer_name,
           i.number as invoice_number,
           -- What the customer owed straight after this return, so a reprint shows the figure of the day.
           (select coalesce(sum(l.debit_paisa - l.credit_paisa), 0) from party_ledger l
            where l.business_id = r.business_id and l.party_type = 'customer' and l.party_id = r.customer_id
              and l.seq <= coalesce((select max(x.seq) from party_ledger x where x.doc_id = r.id), 9223372036854775807)) as customer_balance
    from sales_returns r
    join branches b on b.id = r.branch_id join terminals t on t.id = r.terminal_id
    left join users u on u.id = r.created_by
    left join customers c on c.id = r.customer_id
    left join sales_invoices i on i.id = r.original_invoice_id
    where r.business_id = ${businessId} and r.id = ${id}
  `);
  if (!row) return null;
  const lines = await db.execute(sql`select * from sales_return_lines where return_id = ${id} and business_id = ${businessId} order by line_no`);
  return {
    id: String(row.id), number: String(row.number), postedAt: row.posted_at, branchName: row.branch_name, terminalName: row.terminal_name, cashierName: row.cashier_name,
    shiftId: row.shift_id, invoiceId: row.original_invoice_id ?? null, invoiceNumber: row.invoice_number ?? null,
    customerId: row.customer_id ?? null, customerName: row.customer_name ?? null, customerBalancePaisa: row.customer_id ? paisa(row.customer_balance) : null,
    fbrStatus: row.fbr_status ? String(row.fbr_status) : null, fbrIrn: row.fbr_irn ? String(row.fbr_irn) : null, fbrQr: row.fbr_qr ? String(row.fbr_qr) : null,
    reason: String(row.reason), taxMode: row.tax_mode, grossPaisa: paisa(row.gross_paisa), lineDiscountPaisa: paisa(row.line_discount_paisa),
    invoiceDiscountPaisa: paisa(row.invoice_discount_paisa), taxablePaisa: paisa(row.taxable_paisa), taxPaisa: paisa(row.tax_paisa),
    roundingPaisa: paisa(row.rounding_paisa), totalPaisa: paisa(row.total_paisa),
    refundMethodName: row.refund_method_name ?? null, refundPaisa: paisa(row.refund_paisa), refundReference: String(row.refund_reference),
    accountCreditPaisa: paisa(row.account_credit_paisa), approved: Boolean(row.approved_by), approvalNote: row.approval_note ?? null,
    lines: lines.map((line) => ({
      lineNo: line.line_no, variantId: line.variant_id, unitId: line.unit_id, productName: line.product_name, variantName: line.variant_name, sku: line.sku,
      unitName: line.unit_name, quantity: quantityText(String(line.qty_entered)), unitPricePaisa: paisa(line.unit_price_paisa), grossPaisa: paisa(line.gross_paisa),
      lineDiscountPaisa: paisa(line.line_discount_paisa), invoiceDiscountSharePaisa: paisa(line.invoice_discount_share_paisa), netPaisa: paisa(line.net_paisa),
      taxRateBps: line.tax_rate_bps, taxPaisa: paisa(line.tax_paisa), totalPaisa: paisa(line.total_paisa), restockTo: line.restock_to, reason: String(line.reason),
    })),
  };
}

const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});

/** Credit notes, newest first. Without reports.sales.view a person sees only the ones they took. */
returnRoutes.get("/returns", useReturns, async (context) => {
  const principal = getPrincipal(context);
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const search = context.req.query("q")?.trim();
  const rows = await db.execute(sql`
    select r.id, r.number, r.posted_at, r.total_paisa, r.refund_paisa, r.account_credit_paisa, r.refund_method_name,
           i.number as invoice_number, c.name as customer_name, u.display_name as cashier_name, count(*) over () as total
    from sales_returns r
    left join sales_invoices i on i.id = r.original_invoice_id
    left join customers c on c.id = r.customer_id
    left join users u on u.id = r.created_by
    where r.business_id = ${principal.businessId!}
      ${hasPermission(principal, "reports.sales.view") ? sql`` : sql`and r.created_by = ${getActorId(principal)}`}
      ${search ? sql`and (r.number ilike ${`%${escapeLike(search)}%`} or i.number ilike ${`%${escapeLike(search)}%`})` : sql``}
    order by r.posted_at desc, r.id limit ${pageSize} offset ${(page - 1) * pageSize}
  `);
  return context.json({
    data: rows.map((row) => ({
      id: row.id, number: row.number, postedAt: row.posted_at, totalPaisa: paisa(row.total_paisa), refundPaisa: paisa(row.refund_paisa),
      accountCreditPaisa: paisa(row.account_credit_paisa), refundMethodName: row.refund_method_name ?? null, invoiceNumber: row.invoice_number ?? null,
      customerName: row.customer_name ?? null, cashierName: row.cashier_name ?? null,
    })),
    page, pageSize, total: rows.length ? Number(rows[0].total) : 0,
  });
});

returnRoutes.get("/returns/:id", useReturns, async (context) => {
  const note = await loadReturn(getPrincipal(context).businessId!, paramId(context));
  return note ? context.json(note) : apiError(context, 404, "NOT_FOUND", "Return not found");
});

const reprintSchema = z.object({ format: z.enum(["pos80", "pos58", "a4", "a5"]) });

/** A reprint is never the original: it is logged, counted, and the response says to print DUPLICATE on it. */
returnRoutes.post("/returns/:id/reprint", requirePermission("sales.reprint"), validateJson(reprintSchema), async (context) => {
  const principal = getPrincipal(context);
  const creditNote = await loadReturn(principal.businessId!, paramId(context));
  if (!creditNote) return apiError(context, 404, "NOT_FOUND", "Return not found");
  const { format } = context.req.valid("json");
  const [{ before }] = await db.select({ before: sql<number>`count(*)::int` }).from(auditLog)
    .where(and(eq(auditLog.businessId, principal.businessId!), eq(auditLog.entity, "sales_return"), eq(auditLog.entityId, creditNote.id), eq(auditLog.action, "reprint")));
  await auditPrincipal(context, principal, "sales_return", creditNote.id, "reprint", null, { format, number: creditNote.number });
  return context.json({ creditNote, format, duplicate: true, reprintNumber: before + 1 });
});

