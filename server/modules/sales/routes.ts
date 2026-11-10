import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { auditLog, businessSettings, customerGroups, customers, priceListItems, priceLists, roles, terminals } from "../../../db/schema";
import { formatPkr } from "../../../shared/money";
import { effectivePriceListId, tierPrice, type PriceListItem } from "../../../shared/priceLists";
import { PaymentError, settleTenders, type Tender } from "../../../shared/payments";
import { discountsOverLimit, priceCart, PricingError, type PricingInput } from "../../../shared/pricing";
import { postSaleSchema } from "../../../shared/schemas/sales";
import { formatQuantity, parseQuantity, toBaseQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, hasPermission, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { approveByManager } from "./approval";
import { describeShortage as describeOrderShortage } from "./orders";
import { resolveSalesLocationId } from "./location";
import { canSeeCost, escapeLike, quantityText } from "../products/service";

export const salesRoutes = new Hono();

/** Rule violations raised by the posting function, as the status and code the till understands. */
const postingErrors: Array<[prefix: string, status: 409 | 422, code: string]> = [
  ["SHIFT_NOT_OPEN", 409, "SHIFT_NOT_OPEN"],
  ["STOCK_INSUFFICIENT", 409, "STOCK_INSUFFICIENT"],
  ["INVALID_LINE", 422, "INVALID_LINE"],
  ["PAYMENT_MISMATCH", 422, "PAYMENT_MISMATCH"],
  ["INVALID_CUSTOMER", 422, "INVALID_CUSTOMER"],
];

/** The database says what is wrong with the credit in paisa; the cashier needs it in words. */
export function describeCredit(code: string, message: string, customerName: string): string {
  if (code === "CREDIT_LIMIT_EXCEEDED") {
    const found = /owes (-?\d+), this sale adds (\d+), limit (\d+)/.exec(message);
    if (!found) return `${customerName} is over their credit limit`;
    const [owes, adds, limit] = [Number(found[1]), Number(found[2]), Number(found[3])];
    return limit === 0
      ? `${customerName} has no credit account. A manager must approve putting ${formatPkr(adds)} on credit.`
      : `${customerName} owes ${formatPkr(owes)}. Putting ${formatPkr(adds)} more on credit passes their limit of ${formatPkr(limit)}. A manager must approve.`;
  }
  const days = /more than (\d+) days/.exec(message)?.[1];
  return `${customerName} has an invoice unpaid for more than ${days ?? "the agreed"} days. A manager must approve more credit.`;
}

/** The database says which SKU ran short by id; the cashier needs its name and the numbers. */
async function describeShortage(businessId: string, message: string): Promise<string> {
  // Stock held for open sales orders has its own wording (it names what is reserved).
  if (/ available \(/.test(message)) return describeOrderShortage(businessId, message);
  const found = /variant ([0-9a-f-]{36}) has (-?[\d.]+) on hand, needs ([\d.]+)/i.exec(message);
  if (!found) return "Not enough stock to complete this sale";
  const [row] = await db.execute<{ name: string; sku: string }>(sql`
    select p.name, v.sku from product_variants v join products p on p.id = v.product_id where v.id = ${found[1]} and v.business_id = ${businessId}
  `);
  return `Not enough stock${row ? ` of ${row.name} (${row.sku})` : ""}: ${quantityText(found[2])} on hand, ${quantityText(found[3])} needed (counted in the base unit).`;
}

type LineFacts = {
  variant_id: string; unit_id: string; product_name: string; variant_name: string; sku: string; unit_name: string; hs_code: string | null;
  factor_to_base: string; sale_price_paisa: string; rate_bps: number | null; product_type: string;
};

salesRoutes.post("/sales", requirePermission("sales.create"), idempotent(), validateJson(postSaleSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const actor = getActorId(principal);
  const input = context.req.valid("json");

  if (!principal.terminalId) return apiError(context, 400, "TERMINAL_REQUIRED", "Sales are rung up on a registered terminal");
  const [terminal] = await db.select().from(terminals)
    .where(and(eq(terminals.id, principal.terminalId), eq(terminals.businessId, businessId), eq(terminals.active, true))).limit(1);
  if (!terminal) return apiError(context, 400, "TERMINAL_REQUIRED", "Sales are rung up on a registered terminal");

  const locationId = await resolveSalesLocationId(terminal);
  if (!locationId) return apiError(context, 409, "NO_SALES_LOCATION", "This branch has no store location to sell from");

  const [settings] = await db.select().from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1);
  if (!settings) return apiError(context, 409, "SETTINGS_MISSING", "The business settings are missing");

  // Each line's facts as they are in the catalogue now: the browser's idea of price and tax is never trusted.
  const keys = input.lines.map((line) => sql`(${line.variantId}::uuid, ${line.unitId}::uuid)`);
  const facts = await db.execute<LineFacts>(sql`
    select v.id as variant_id, pu.unit_id, p.name as product_name, v.variant_name, v.sku, u.name as unit_name, p.hs_code,
           pu.factor_to_base::text, pu.sale_price_paisa::text, tc.rate_bps, p.product_type
    from product_units pu
    join product_variants v on v.id = pu.variant_id and v.business_id = pu.business_id and v.active
    join products p on p.id = v.product_id and p.active
    join units u on u.id = pu.unit_id
    left join tax_categories tc on tc.id = p.tax_category_id
    where pu.business_id = ${businessId} and (pu.variant_id, pu.unit_id) in (${sql.join(keys, sql`, `)})
  `);
  const factsOf = (variantId: string, unitId: string) => facts.find((row) => row.variant_id === variantId && row.unit_id === unitId);
  const missing = input.lines.findIndex((line) => !factsOf(line.variantId, line.unitId));
  if (missing >= 0) return apiError(context, 422, "INVALID_LINE", `Line ${missing + 1} is not an active product sold in that unit`);

  // A named customer buys at their tier: their own price list, else their group's.
  let customerId: string | null = null;
  let customerName = "";
  let tierItems: PriceListItem[] = [];
  if (input.customerId) {
    const [customer] = await db.select().from(customers).where(and(eq(customers.id, input.customerId), eq(customers.businessId, businessId), eq(customers.active, true))).limit(1);
    if (!customer) return apiError(context, 422, "INVALID_CUSTOMER", "This customer is not available");
    customerId = customer.id;
    customerName = customer.name;
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
  const pricingInput: PricingInput = {
    taxMode: settings.taxMode,
    cashRounding: settings.cashRoundingPaisa as 0 | 100 | 500 | 1000,
    invoiceDiscount: input.invoiceDiscount ?? null,
    lines: [],
  };
  for (const [index, line] of input.lines.entries()) {
    const fact = factsOf(line.variantId, line.unitId)!;
    const qtyMilli = parseQuantity(line.quantity);
    const shelfPrice = tierPrice(tierItems, line.variantId, line.unitId, qtyMilli) ?? Number(fact.sale_price_paisa);
    if (line.unitPricePaisa !== undefined && line.unitPricePaisa !== shelfPrice && !mayOverridePrice) {
      return apiError(context, 403, "PRICE_OVERRIDE_DENIED", `Line ${index + 1}: you may not change the price`);
    }
    pricingInput.lines.push({
      qtyMilli,
      unitPricePaisa: line.unitPricePaisa ?? shelfPrice,
      taxRateBps: fact.rate_bps ?? 0,
      discount: line.discount ?? null,
    });
  }

  let priced;
  try {
    priced = priceCart(pricingInput);
  } catch (error) {
    if (error instanceof PricingError) return apiError(context, 422, error.code, error.message);
    throw error;
  }

  // Discounts (FR-SAL-04): allowed up to the role's limit; above it a manager must approve with their PIN.
  const hasDiscount = Boolean(input.invoiceDiscount) || input.lines.some((line) => line.discount);
  if (hasDiscount && !hasPermission(principal, "sales.discount")) {
    return apiError(context, 403, "DISCOUNT_DENIED", "You may not give discounts");
  }
  let approvedBy: string | null = null;
  let approvalNote: string | null = null;
  if (hasDiscount) {
    const [role] = await db.select({ limit: roles.maxDiscountBps }).from(roles).where(eq(roles.id, principal.roleId!)).limit(1);
    const breaches = discountsOverLimit(pricingInput, priced, hasPermission(principal, "sales.discount.above_limit") ? 10000 : role?.limit ?? 0);
    if (breaches.length) {
      if (!input.approval) {
        return apiError(context, 403, "DISCOUNT_APPROVAL_REQUIRED", "This discount is more than you may give. A manager must approve it.");
      }
      const manager = await approveByManager(businessId, terminal.branchId, input.approval.managerEmail, input.approval.pin, "sales.discount.above_limit");
      if (manager === "rate-limited") return apiError(context, 429, "RATE_LIMITED", "Too many PIN attempts. Wait 15 minutes and try again.");
      if (manager === "invalid") return apiError(context, 401, "INVALID_PIN", "Manager email or PIN is incorrect");
      if (manager === "not-allowed") return apiError(context, 403, "OVERRIDE_NOT_ALLOWED", "This manager cannot approve discounts at this terminal");
      approvedBy = manager;
      approvalNote = `Discount above ${role?.limit ?? 0} bps limit`;
    }
  }

  if (input.expectedTotalPaisa !== undefined && input.expectedTotalPaisa !== priced.totalPaisa) {
    return apiError(context, 409, "TOTAL_CHANGED", "The total changed since it was shown (a price or tax rate was updated). Check the cart and try again.");
  }

  // Payments: the method's kind decides whether it can be over-tendered (cash) or must match exactly.
  const methods = input.payments.length === 0 ? [] : await db.execute<{ id: string; kind: string }>(sql`
    select id, kind from payment_methods where business_id = ${businessId} and active and id in (${sql.join(input.payments.map((payment) => sql`${payment.methodId}::uuid`), sql`, `)})
  `);
  const kindOf = (id: string) => methods.find((method) => method.id === id)?.kind;
  if (input.payments.some((payment) => !kindOf(payment.methodId))) return apiError(context, 422, "PAYMENT_MISMATCH", "A payment method is not available");
  let settlement;
  try {
    const tenders: Tender[] = input.payments.map((payment) => ({ kind: kindOf(payment.methodId) === "cash" ? "cash" : "other", amountPaisa: payment.amountPaisa }));
    settlement = settleTenders(priced.totalPaisa, tenders);
  } catch (error) {
    if (error instanceof PaymentError) return apiError(context, 422, error.code, error.message);
    throw error;
  }
  // Only a named customer may leave something unpaid: it goes on their account. A walk-in pays in full.
  if (settlement.balancePaisa !== 0 && !customerId) {
    return apiError(context, 422, "PAYMENT_MISMATCH", input.payments.length ? "The payments do not cover the bill" : "Choose a customer to sell on credit, or take the payment");
  }

  // Credit above the limit, or for an overdue customer, needs a manager. The database decides whether it is needed (it holds the
  // customer's balance under a lock); here we only check who is approving.
  let creditApprovedBy: string | null = null;
  if (settlement.balancePaisa > 0 && input.approval) {
    const manager = await approveByManager(businessId, terminal.branchId, input.approval.managerEmail, input.approval.pin, "sales.credit_override");
    if (manager === "rate-limited") return apiError(context, 429, "RATE_LIMITED", "Too many PIN attempts. Wait 15 minutes and try again.");
    if (manager === "invalid") return apiError(context, 401, "INVALID_PIN", "Manager email or PIN is incorrect");
    if (manager !== "not-allowed") creditApprovedBy = manager;
  }

  const payload = {
    business_id: businessId, customer_id: customerId, credit_approved_by: creditApprovedBy, branch_id: terminal.branchId, terminal_id: terminal.id, shift_id: input.shiftId, location_id: locationId,
    allow_negative_stock: settings.allowNegativeStock, tax_mode: settings.taxMode,
    gross_paisa: priced.grossPaisa, line_discount_paisa: priced.lineDiscountPaisa, invoice_discount_paisa: priced.invoiceDiscountPaisa,
    taxable_paisa: priced.taxablePaisa, tax_paisa: priced.taxPaisa, rounding_paisa: priced.roundingPaisa, total_paisa: priced.totalPaisa,
    approved_by: approvedBy, approval_note: approvalNote,
    lines: input.lines.map((line, index) => {
      const fact = factsOf(line.variantId, line.unitId)!;
      const entered = parseQuantity(line.quantity);
      const base = toBaseQuantity(entered, parseQuantity(quantityText(fact.factor_to_base)));
      const priceLine = pricingInput.lines[index];
      const out = priced.lines[index];
      return {
        line_no: index + 1, variant_id: line.variantId, unit_id: line.unitId, product_name: fact.product_name, variant_name: fact.variant_name,
        sku: fact.sku, unit_name: fact.unit_name, hs_code: fact.hs_code, qty_entered: formatQuantity(entered), factor_to_base: quantityText(fact.factor_to_base),
        qty_base: formatQuantity(base), unit_price_paisa: priceLine.unitPricePaisa, gross_paisa: out.grossPaisa, line_discount_paisa: out.lineDiscountPaisa,
        invoice_discount_share_paisa: out.invoiceDiscountSharePaisa, net_paisa: out.netPaisa, tax_rate_bps: priceLine.taxRateBps,
        tax_included: settings.taxMode === "inclusive", taxable_paisa: out.taxablePaisa, tax_paisa: out.taxPaisa, total_paisa: out.totalPaisa,
      };
    }),
    payments: input.payments.map((payment, index) => ({
      method_id: payment.methodId, amount_paisa: settlement.tenders[index].appliedPaisa, tendered_paisa: settlement.tenders[index].tenderedPaisa,
      change_paisa: settlement.tenders[index].changePaisa, reference: payment.reference,
    })),
  };

  let invoiceId: string;
  try {
    invoiceId = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select post_sales_invoice(${JSON.stringify(payload)}::jsonb, ${actor}) as id`);
      return row.id;
    });
  } catch (error) {
    const message = dbErrorMessage(error);
    const known = postingErrors.find(([prefix]) => message.includes(prefix));
    if (known?.[2] === "STOCK_INSUFFICIENT") return apiError(context, 409, "STOCK_INSUFFICIENT", await describeShortage(businessId, message));
    const credit = /CREDIT_LIMIT_EXCEEDED|CUSTOMER_OVERDUE/.exec(message)?.[0];
    if (credit) return apiError(context, 409, credit, describeCredit(credit, message, customerName));
    if (known) return apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message);
    throw error;
  }

  await auditPrincipal(context, principal, "sales_invoice", invoiceId, "post", null, { totalPaisa: priced.totalPaisa, lines: input.lines.length, approvedBy });
  const invoice = await loadInvoice(businessId, invoiceId, canSeeCost(principal));
  // The till updates its cached stock from this instead of asking again (technical-plan 5.7).
  const stock = await db.execute<{ variant_id: string; on_hand: string }>(sql`
    select variant_id, sum(on_hand)::text as on_hand from stock_balances
    where business_id = ${businessId} and location_id = ${locationId} and variant_id in (${sql.join(input.lines.map((line) => sql`${line.variantId}::uuid`), sql`, `)})
    group by variant_id
  `);
  return context.json({ invoice, stock: stock.map((row) => ({ variantId: row.variant_id, onHand: quantityText(row.on_hand) })) }, 201);
});

export async function loadInvoice(businessId: string, id: string, withCost: boolean) {
  const [invoice] = await db.execute(sql`
    select i.*, b.name as branch_name, t.name as terminal_name, u.display_name as cashier_name, c.name as customer_name, so.number as order_number,
           -- What the customer owed straight after this invoice, so a reprint shows the figure of the day.
           (select coalesce(sum(l.debit_paisa - l.credit_paisa), 0) from party_ledger l
            where l.business_id = i.business_id and l.party_type = 'customer' and l.party_id = i.customer_id
              and l.seq <= (select max(x.seq) from party_ledger x where x.doc_id = i.id)) as customer_balance
    from sales_invoices i
    join branches b on b.id = i.branch_id left join terminals t on t.id = i.terminal_id
    left join users u on u.id = i.cashier_id
    left join customers c on c.id = i.customer_id left join sales_orders so on so.id = i.order_id
    where i.business_id = ${businessId} and i.id = ${id}
  `);
  if (!invoice) return null;
  const lines = await db.execute(sql`select * from sales_invoice_lines where invoice_id = ${id} and business_id = ${businessId} order by line_no`);
  const payments = await db.execute(sql`select p.* from payments p join payment_methods m on m.id = p.method_id where p.invoice_id = ${id} and p.business_id = ${businessId} order by m.sort_order, p.id`);
  const paisa = (value: unknown) => Number(value);
  return {
    id: String(invoice.id),
    number: String(invoice.number),
    postedAt: invoice.posted_at,
    branchName: invoice.branch_name,
    terminalName: invoice.terminal_name ?? "",
    channel: String(invoice.channel),
    orderId: invoice.order_id ? String(invoice.order_id) : null,
    orderNumber: invoice.order_number ? String(invoice.order_number) : null,
    quotationId: invoice.quotation_id ? String(invoice.quotation_id) : null,
    termsDays: invoice.terms_days === null || invoice.terms_days === undefined ? null : Number(invoice.terms_days),
    dueDate: invoice.due_date ? String(invoice.due_date).slice(0, 10) : null,
    customerPo: String(invoice.customer_po ?? ""),
    note: String(invoice.note ?? ""),
    buyerName: String(invoice.buyer_name ?? ""),
    buyerNtn: invoice.buyer_ntn ? String(invoice.buyer_ntn) : null,
    buyerStrn: invoice.buyer_strn ? String(invoice.buyer_strn) : null,
    buyerAddress: String(invoice.buyer_address ?? ""),
    cashierName: invoice.cashier_name,
    shiftId: invoice.shift_id ?? null,
    customerId: invoice.customer_id ?? null,
    customerName: invoice.customer_name ?? null,
    customerBalancePaisa: invoice.customer_id ? paisa(invoice.customer_balance) : null,
    taxMode: invoice.tax_mode,
    grossPaisa: paisa(invoice.gross_paisa),
    lineDiscountPaisa: paisa(invoice.line_discount_paisa),
    invoiceDiscountPaisa: paisa(invoice.invoice_discount_paisa),
    taxablePaisa: paisa(invoice.taxable_paisa),
    taxPaisa: paisa(invoice.tax_paisa),
    roundingPaisa: paisa(invoice.rounding_paisa),
    totalPaisa: paisa(invoice.total_paisa),
    paidPaisa: paisa(invoice.paid_paisa),
    changePaisa: paisa(invoice.change_paisa),
    balancePaisa: paisa(invoice.balance_paisa),
    lines: lines.map((line) => ({
      lineNo: line.line_no, variantId: line.variant_id, unitId: line.unit_id, productName: line.product_name, variantName: line.variant_name,
      sku: line.sku, unitName: line.unit_name, hsCode: line.hs_code, quantity: quantityText(String(line.qty_entered)),
      unitPricePaisa: paisa(line.unit_price_paisa), grossPaisa: paisa(line.gross_paisa), lineDiscountPaisa: paisa(line.line_discount_paisa),
      invoiceDiscountSharePaisa: paisa(line.invoice_discount_share_paisa), netPaisa: paisa(line.net_paisa), taxRateBps: line.tax_rate_bps,
      taxPaisa: paisa(line.tax_paisa), totalPaisa: paisa(line.total_paisa), returnedQuantity: quantityText(String(line.returned_qty_base)),
      ...(withCost ? { costPaisa: paisa(line.cost_paisa) } : {}),
    })),
    payments: payments.map((payment) => ({
      methodCode: payment.method_code, methodName: payment.method_name, amountPaisa: paisa(payment.amount_paisa),
      tenderedPaisa: paisa(payment.tendered_paisa), changePaisa: paisa(payment.change_paisa), reference: payment.reference,
    })),
  };
}

salesRoutes.get("/sales/:id", requirePermission("sales.create"), async (context) => {
  const principal = getPrincipal(context);
  const invoice = await loadInvoice(principal.businessId!, paramId(context), canSeeCost(principal));
  return invoice ? context.json(invoice) : apiError(context, 404, "NOT_FOUND", "Sale not found");
});

const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});
const uuidParam = (value: string | undefined) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined);
const dateParam = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);

/** Posted sales, newest first. Without reports.sales.view a person sees only the sales they rang up. */
salesRoutes.get("/sales", requirePermission("sales.create"), async (context) => {
  const principal = getPrincipal(context);
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const search = context.req.query("q")?.trim();
  const shiftId = uuidParam(context.req.query("shiftId"));
  const from = dateParam(context.req.query("from"));
  const to = dateParam(context.req.query("to"));
  const rows = await db.execute(sql`
    select i.id, i.number, i.posted_at, i.total_paisa, i.paid_paisa, i.shift_id, u.display_name as cashier_name, count(*) over () as total
    from sales_invoices i left join users u on u.id = i.cashier_id
    where i.business_id = ${principal.businessId!}
      ${hasPermission(principal, "reports.sales.view") ? sql`` : sql`and i.cashier_id = ${getActorId(principal)}`}
      ${search ? sql`and i.number ilike ${`%${escapeLike(search)}%`}` : sql``}
      ${shiftId ? sql`and i.shift_id = ${shiftId}` : sql``}
      ${from ? sql`and i.posted_at >= (${from}::date)::timestamp at time zone 'Asia/Karachi'` : sql``}
      ${to ? sql`and i.posted_at < (${to}::date + 1)::timestamp at time zone 'Asia/Karachi'` : sql``}
    order by i.posted_at desc, i.id limit ${pageSize} offset ${(page - 1) * pageSize}
  `);
  return context.json({
    data: rows.map((row) => ({
      id: row.id, number: row.number, postedAt: row.posted_at, totalPaisa: Number(row.total_paisa), paidPaisa: Number(row.paid_paisa),
      shiftId: row.shift_id, cashierName: row.cashier_name,
    })),
    page, pageSize, total: rows.length ? Number(rows[0].total) : 0,
  });
});

const reprintSchema = z.object({ format: z.enum(["pos80", "pos58", "a4", "a5"]) });

/** A reprint is never the original: it is logged, counted, and the response says to print DUPLICATE on it (FR-PRT). */
salesRoutes.post("/sales/:id/reprint", requirePermission("sales.reprint"), validateJson(reprintSchema), async (context) => {
  const principal = getPrincipal(context);
  const invoice = await loadInvoice(principal.businessId!, paramId(context), canSeeCost(principal));
  if (!invoice) return apiError(context, 404, "NOT_FOUND", "Sale not found");
  const { format } = context.req.valid("json");
  const [{ before }] = await db.select({ before: sql<number>`count(*)::int` }).from(auditLog)
    .where(and(eq(auditLog.businessId, principal.businessId!), eq(auditLog.entity, "sales_invoice"), eq(auditLog.entityId, invoice.id), eq(auditLog.action, "reprint")));
  await auditPrincipal(context, principal, "sales_invoice", invoice.id, "reprint", null, { format, number: invoice.number });
  return context.json({ invoice, format, duplicate: true, reprintNumber: before + 1 });
});
