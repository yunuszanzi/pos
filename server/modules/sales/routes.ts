import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { appUsers, auditLog, businessSettings, rolePermissions, roles, terminals, userBranches } from "../../../db/schema";
import { PaymentError, settleTenders, type Tender } from "../../../shared/payments";
import { discountsOverLimit, priceCart, PricingError, type PricingInput } from "../../../shared/pricing";
import { postSaleSchema } from "../../../shared/schemas/sales";
import { formatQuantity, parseQuantity, toBaseQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { createPinRateKey } from "../../lib/auth";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, hasPermission, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { verifyPin } from "../auth/pin";
import { clearPinAttempts, registerPinAttempt } from "../auth/pinRateLimit";
import { resolveSalesLocationId } from "./location";
import { canSeeCost, escapeLike, quantityText } from "../products/service";

export const salesRoutes = new Hono();

/** Rule violations raised by the posting function, as the status and code the till understands. */
const postingErrors: Array<[prefix: string, status: 409 | 422, code: string]> = [
  ["SHIFT_NOT_OPEN", 409, "SHIFT_NOT_OPEN"],
  ["STOCK_INSUFFICIENT", 409, "STOCK_INSUFFICIENT"],
  ["INVALID_LINE", 422, "INVALID_LINE"],
  ["PAYMENT_MISMATCH", 422, "PAYMENT_MISMATCH"],
];

/** A manager's email and PIN, checked the same way as /auth/manager-override. Returns the manager's id. */
async function approveByManager(businessId: string, terminalBranchId: string, email: string, pin: string, permission: string) {
  const rateKey = createPinRateKey(`override|${email.toLowerCase()}`);
  if (!(await registerPinAttempt(rateKey)).allowed) return "rate-limited" as const;
  const [manager] = await db.select().from(appUsers)
    .where(and(eq(appUsers.businessId, businessId), ilike(appUsers.email, email), eq(appUsers.active, true))).limit(1);
  if (!manager || !await verifyPin(pin, manager.pinHash)) return "invalid" as const;
  const [branchGrant] = await db.select().from(userBranches)
    .where(and(eq(userBranches.userId, manager.id), eq(userBranches.branchId, terminalBranchId))).limit(1);
  const [grant] = await db.select().from(rolePermissions)
    .where(and(eq(rolePermissions.roleId, manager.roleId), inArray(rolePermissions.permissionKey, [permission, "*"]))).limit(1);
  await clearPinAttempts(rateKey);
  return branchGrant && grant ? manager.id : "not-allowed" as const;
}

/** The database says which SKU ran short by id; the cashier needs its name and the numbers. */
async function describeShortage(businessId: string, message: string): Promise<string> {
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

  const mayOverridePrice = hasPermission(principal, "sales.price_override");
  const pricingInput: PricingInput = {
    taxMode: settings.taxMode,
    cashRounding: settings.cashRoundingPaisa as 0 | 100 | 500 | 1000,
    invoiceDiscount: input.invoiceDiscount ?? null,
    lines: [],
  };
  for (const [index, line] of input.lines.entries()) {
    const fact = factsOf(line.variantId, line.unitId)!;
    const shelfPrice = Number(fact.sale_price_paisa);
    if (line.unitPricePaisa !== undefined && line.unitPricePaisa !== shelfPrice && !mayOverridePrice) {
      return apiError(context, 403, "PRICE_OVERRIDE_DENIED", `Line ${index + 1}: you may not change the price`);
    }
    pricingInput.lines.push({
      qtyMilli: parseQuantity(line.quantity),
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
  const methods = await db.execute<{ id: string; kind: string }>(sql`
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
  if (settlement.balancePaisa !== 0) return apiError(context, 422, "PAYMENT_MISMATCH", "The payments do not cover the bill");

  const payload = {
    business_id: businessId, branch_id: terminal.branchId, terminal_id: terminal.id, shift_id: input.shiftId, location_id: locationId,
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

async function loadInvoice(businessId: string, id: string, withCost: boolean) {
  const [invoice] = await db.execute(sql`
    select i.*, b.name as branch_name, t.name as terminal_name, u.display_name as cashier_name
    from sales_invoices i
    join branches b on b.id = i.branch_id join terminals t on t.id = i.terminal_id
    left join users u on u.id = i.cashier_id
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
    terminalName: invoice.terminal_name,
    cashierName: invoice.cashier_name,
    shiftId: invoice.shift_id,
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
