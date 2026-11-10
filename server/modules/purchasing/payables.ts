import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { suppliers, terminals, userBranches } from "../../../db/schema";
import { inputTaxOf } from "../../../shared/purchaseBills";
import { purchaseLineValue } from "../../../shared/purchasing";
import { purchaseReturnSchema, supplierPaymentSchema } from "../../../shared/schemas/supplierPayments";
import { formatQuantity, parseQuantity, toBaseQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { escapeLike } from "../products/service";

// Paying suppliers and returning goods to them (FR-PUR-05, FR-PUR-06).

export const payablesRoutes = new Hono();

const viewLedger = requirePermission("suppliers.ledger");
const pay = requirePermission("suppliers.pay");
const costs = requirePermission("products.cost.view");
const paisa = (value: unknown) => Number(value);
const quantityText = (value: unknown) => formatQuantity(parseQuantity(String(value)));
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);
const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});
const uuidParam = (value: string | undefined) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined);

const functionErrors: Array<[prefix: string, status: 404 | 409 | 422, code: string]> = [
  ["NOT_FOUND", 404, "NOT_FOUND"],
  ["SHIFT_NOT_OPEN", 409, "SHIFT_NOT_OPEN"],
  ["INVALID_SUPPLIER", 422, "INVALID_SUPPLIER"],
  ["INVALID_PAYMENT", 422, "INVALID_PAYMENT"],
  ["INVALID_ALLOCATION", 422, "INVALID_ALLOCATION"],
  ["INVALID_LINE", 422, "INVALID_LINE"],
  ["RETURN_EXCEEDS_RECEIVED", 409, "RETURN_EXCEEDS_RECEIVED"],
  ["RETURN_TOTAL_MISMATCH", 422, "RETURN_TOTAL_MISMATCH"],
  ["STOCK_INSUFFICIENT", 409, "STOCK_INSUFFICIENT"],
];
function mapFunctionError(context: Context, error: unknown): Response | null {
  const message = dbErrorMessage(error);
  const known = functionErrors.find(([prefix]) => message.includes(prefix));
  return known ? apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message) : null;
}

async function timezoneOf(businessId: string) {
  const [settings] = await db.execute<{ timezone: string }>(sql`select timezone from business_settings where business_id = ${businessId}`);
  return settings?.timezone ?? "Asia/Karachi";
}

// ---------------------------------------------------------------- what is owed, bill by bill

/** A supplier's open bills, oldest first: what is still owing on each, and whether it is past its due date. */
payablesRoutes.get("/suppliers/:id/open-bills", viewLedger, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const [supplier] = await db.select({ id: suppliers.id }).from(suppliers).where(and(eq(suppliers.id, paramId(context)), eq(suppliers.businessId, businessId))).limit(1);
  if (!supplier) return apiError(context, 404, "NOT_FOUND", "Supplier not found");
  const timezone = await timezoneOf(businessId);
  const rows = await db.execute(sql`
    select bill_id, number, supplier_invoice_no, bill_date, due_date, total_paisa, outstanding_paisa, due_date < (now() at time zone ${timezone})::date as overdue
    from supplier_open_bills(${businessId}::uuid, ${supplier.id}::uuid)`);
  return context.json(rows.map((row) => ({
    billId: String(row.bill_id), number: String(row.number), supplierInvoiceNo: String(row.supplier_invoice_no), billDate: day(row.bill_date), dueDate: day(row.due_date),
    totalPaisa: paisa(row.total_paisa), outstandingPaisa: paisa(row.outstanding_paisa), overdue: Boolean(row.overdue),
  })));
});

// ---------------------------------------------------------------- payments

async function loadPayment(businessId: string, id: string) {
  const [row] = await db.execute(sql`
    select p.*, s.name as supplier_name, s.balance_paisa as supplier_balance, b.name as branch_name, u.display_name as paid_by
    from supplier_payments p join suppliers s on s.id = p.supplier_id join branches b on b.id = p.branch_id left join users u on u.id = p.created_by
    where p.business_id = ${businessId} and p.id = ${id}`);
  if (!row) return null;
  const allocations = await db.execute(sql`
    select a.bill_id, a.amount_paisa, b.number, b.supplier_invoice_no from supplier_payment_allocations a join purchase_bills b on b.id = a.bill_id
    where a.business_id = ${businessId} and a.source_id = ${id} order by b.bill_date, b.number`);
  return {
    id: String(row.id), number: String(row.number), postedAt: iso(row.posted_at), supplierId: String(row.supplier_id), supplierName: String(row.supplier_name),
    branchName: String(row.branch_name), paidBy: row.paid_by ? String(row.paid_by) : null, methodCode: String(row.method_code), methodName: String(row.method_name),
    amountPaisa: paisa(row.amount_paisa), reference: String(row.reference), note: String(row.note),
    // What the shop owes the supplier now, after this payment (a later bill would change it).
    supplierBalancePaisa: paisa(row.supplier_balance),
    allocations: allocations.map((allocation) => ({ billId: String(allocation.bill_id), number: String(allocation.number), supplierInvoiceNo: String(allocation.supplier_invoice_no), amountPaisa: paisa(allocation.amount_paisa) })),
  };
}

/** Pays a supplier. Cash comes out of this terminal's open shift; other methods can be paid from the back office. */
payablesRoutes.post("/supplier-payments", pay, viewLedger, idempotent(), validateJson(supplierPaymentSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");

  let branchId: string | null = null;
  let terminalId: string | null = null;
  let shiftId: string | null = null;
  if (principal.terminalId) {
    const [terminal] = await db.select().from(terminals)
      .where(and(eq(terminals.id, principal.terminalId), eq(terminals.businessId, businessId), eq(terminals.active, true))).limit(1);
    if (terminal) {
      branchId = terminal.branchId;
      terminalId = terminal.id;
      const [open] = await db.execute<{ id: string }>(sql`select id from shifts where business_id = ${businessId} and terminal_id = ${terminal.id} and status = 'open' limit 1`);
      shiftId = open?.id ?? null;
    }
  }
  if (!branchId) {
    // The back office has no till: the payment belongs to the person's own branch, and cash is refused (no drawer to take it from).
    const [mine] = principal.userId ? await db.select({ branchId: userBranches.branchId }).from(userBranches).where(eq(userBranches.userId, principal.userId)).limit(1) : [];
    if (!mine) return apiError(context, 400, "TERMINAL_REQUIRED", "Pay suppliers on a registered terminal or from a user with a branch");
    branchId = mine.branchId;
  }
  const [supplier] = await db.select({ id: suppliers.id }).from(suppliers).where(and(eq(suppliers.id, input.supplierId), eq(suppliers.businessId, businessId))).limit(1);
  if (!supplier) return apiError(context, 422, "INVALID_SUPPLIER", "This supplier is not available");

  const payload = {
    business_id: businessId, branch_id: branchId, terminal_id: terminalId, shift_id: shiftId, supplier_id: input.supplierId, method_id: input.methodId,
    amount_paisa: input.amountPaisa, reference: input.reference, note: input.note,
    allocate: input.allocations ? "manual" : "oldest",
    allocations: (input.allocations ?? []).map((allocation) => ({ bill_id: allocation.billId, amount_paisa: allocation.amountPaisa })),
  };
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select post_supplier_payment(${JSON.stringify(payload)}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const mapped = mapFunctionError(context, error);
    if (mapped) return mapped;
    throw error;
  }
  await auditPrincipal(context, principal, "supplier_payment", id, "post", null, { supplierId: input.supplierId, amountPaisa: input.amountPaisa });
  return context.json(await loadPayment(businessId, id), 201);
});

payablesRoutes.get("/supplier-payments", viewLedger, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const supplierId = uuidParam(context.req.query("supplierId"));
  const search = context.req.query("q")?.trim();
  const filters = [sql`p.business_id = ${businessId}`];
  if (supplierId) filters.push(sql`p.supplier_id = ${supplierId}`);
  if (search) filters.push(sql`(p.number ilike ${`%${escapeLike(search)}%`} or s.name ilike ${`%${escapeLike(search)}%`} or p.reference ilike ${`%${escapeLike(search)}%`})`);
  const rows = await db.execute(sql`
    select p.id, p.number, p.posted_at, p.method_name, p.amount_paisa, p.reference, s.name as supplier_name, count(*) over () as total
    from supplier_payments p join suppliers s on s.id = p.supplier_id where ${sql.join(filters, sql` and `)}
    order by p.posted_at desc, p.number desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id), number: String(row.number), postedAt: iso(row.posted_at), methodName: String(row.method_name), amountPaisa: paisa(row.amount_paisa),
      reference: String(row.reference), supplierName: String(row.supplier_name),
    })),
    page, pageSize, total: rows.length ? paisa(rows[0].total) : 0,
  });
});

payablesRoutes.get("/supplier-payments/:id", viewLedger, async (context) => {
  const found = await loadPayment(getPrincipal(context).businessId!, paramId(context));
  return found ? context.json(found) : apiError(context, 404, "NOT_FOUND", "Payment not found");
});

// ---------------------------------------------------------------- purchase returns

async function loadReturn(businessId: string, id: string) {
  const [row] = await db.execute(sql`
    select r.*, s.name as supplier_name, s.balance_paisa as supplier_balance, g.number as receipt_number, b.name as branch_name, l.name as location_name
    from purchase_returns r join suppliers s on s.id = r.supplier_id join goods_receipts g on g.id = r.receipt_id join branches b on b.id = r.branch_id join locations l on l.id = r.location_id
    where r.business_id = ${businessId} and r.id = ${id}`);
  if (!row) return null;
  const lines = await db.execute(sql`select * from purchase_return_lines where business_id = ${businessId} and return_id = ${id} order by line_no`);
  const allocations = await db.execute(sql`
    select a.bill_id, a.amount_paisa, b.number, b.supplier_invoice_no from supplier_payment_allocations a join purchase_bills b on b.id = a.bill_id
    where a.business_id = ${businessId} and a.source_id = ${id} order by b.bill_date, b.number`);
  const settled = allocations.reduce((sum, allocation) => sum + paisa(allocation.amount_paisa), 0);
  return {
    id: String(row.id), number: String(row.number), postedAt: iso(row.posted_at), supplierId: String(row.supplier_id), supplierName: String(row.supplier_name),
    branchName: String(row.branch_name), locationName: String(row.location_name), receiptId: String(row.receipt_id), receiptNumber: String(row.receipt_number), reason: String(row.reason),
    subtotalPaisa: paisa(row.subtotal_paisa), taxPaisa: paisa(row.tax_paisa), totalPaisa: paisa(row.total_paisa),
    // What the shop owes the supplier now, and how much of this credit went against bills (the rest is credit on their account).
    supplierBalancePaisa: paisa(row.supplier_balance), settledBillsPaisa: settled, onAccountPaisa: paisa(row.total_paisa) - settled,
    allocations: allocations.map((allocation) => ({ billId: String(allocation.bill_id), number: String(allocation.number), supplierInvoiceNo: String(allocation.supplier_invoice_no), amountPaisa: paisa(allocation.amount_paisa) })),
    lines: lines.map((line) => ({
      id: String(line.id), lineNo: Number(line.line_no), receiptLineId: String(line.receipt_line_id), productName: String(line.product_name), variantName: String(line.variant_name),
      sku: String(line.sku), unitName: String(line.unit_name), quantity: quantityText(line.qty_entered), qtyBase: quantityText(line.qty_base),
      unitCostPaisa: paisa(line.unit_cost_paisa), lineValuePaisa: paisa(line.line_value_paisa), taxRateBps: Number(line.tax_rate_bps), taxPaisa: paisa(line.tax_paisa),
    })),
  };
}

/**
 * What can still go back from a goods receipt: each line with how much is left to return (in the unit it was received in), how much
 * is on hand, and the credit it would carry by default (the billed price and tax rate when billed, else the receipt's price).
 */
payablesRoutes.get("/goods-receipts/:id/returnable", costs, requirePermission("purchasing.return"), async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const id = paramId(context);
  const [receipt] = await db.execute(sql`
    select r.id, r.number, r.supplier_id, r.location_id, s.name as supplier_name from goods_receipts r join suppliers s on s.id = r.supplier_id
    where r.business_id = ${businessId} and r.id = ${id}`);
  if (!receipt) return apiError(context, 404, "NOT_FOUND", "Goods receipt not found");
  const rows = await db.execute(sql`
    select rl.id, rl.line_no, rl.variant_id, rl.product_name, rl.variant_name, rl.sku, rl.unit_name, rl.qty_entered, rl.qty_base, rl.returned_base, rl.factor_to_base, rl.unit_cost_paisa,
           coalesce(bl.unit_cost_paisa, rl.unit_cost_paisa) as default_cost, coalesce(bl.tax_rate_bps, 0) as default_tax_bps,
           coalesce((select on_hand from stock_balances sb where sb.variant_id = rl.variant_id and sb.location_id = ${String(receipt.location_id)}::uuid), 0) as on_hand
    from goods_receipt_lines rl
    left join lateral (
      select l.unit_cost_paisa, l.tax_rate_bps from purchase_bill_lines l join purchase_bills b on b.id = l.bill_id
      where l.receipt_line_id = rl.id order by b.created_at desc, b.number desc limit 1
    ) bl on true
    where rl.business_id = ${businessId} and rl.receipt_id = ${id} order by rl.line_no`);
  return context.json({
    receipt: { id: String(receipt.id), number: String(receipt.number), supplierId: String(receipt.supplier_id), supplierName: String(receipt.supplier_name) },
    lines: rows.map((row) => {
      const factor = parseQuantity(String(row.factor_to_base));
      const leftBase = parseQuantity(String(row.qty_base)) - parseQuantity(String(row.returned_base));
      return {
        id: String(row.id), lineNo: Number(row.line_no), productName: String(row.product_name), variantName: String(row.variant_name), sku: String(row.sku), unitName: String(row.unit_name),
        quantity: quantityText(row.qty_entered), factorToBase: quantityText(row.factor_to_base), returnedBase: quantityText(row.returned_base), onHandBase: quantityText(row.on_hand),
        returnableQuantity: formatQuantity(Math.floor((leftBase * 1000) / factor)), defaultUnitCostPaisa: paisa(row.default_cost), defaultTaxRateBps: Number(row.default_tax_bps),
      };
    }),
  });
});

/** Returns goods to a supplier: stock goes down, and the supplier's credit settles their oldest open bills. */
payablesRoutes.post("/purchase-returns", costs, requirePermission("purchasing.return"), idempotent(), validateJson(purchaseReturnSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");

  const defaults = await db.execute<{ id: string; factor_to_base: string; default_cost: string; default_tax_bps: string }>(sql`
    select rl.id, rl.factor_to_base::text as factor_to_base, coalesce(bl.unit_cost_paisa, rl.unit_cost_paisa) as default_cost, coalesce(bl.tax_rate_bps, 0) as default_tax_bps
    from goods_receipt_lines rl
    left join lateral (
      select l.unit_cost_paisa, l.tax_rate_bps from purchase_bill_lines l join purchase_bills b on b.id = l.bill_id
      where l.receipt_line_id = rl.id order by b.created_at desc, b.number desc limit 1
    ) bl on true
    where rl.business_id = ${businessId} and rl.receipt_id = ${input.receiptId}`);
  const byId = new Map(defaults.map((row) => [row.id, row]));
  if (input.lines.some((line) => !byId.has(line.receiptLineId))) return apiError(context, 422, "INVALID_LINE", "A line is not on this goods receipt");

  const worked = input.lines.map((line) => {
    const base = byId.get(line.receiptLineId)!;
    const entered = parseQuantity(line.quantity);
    const unitCost = line.unitCostPaisa ?? paisa(base.default_cost);
    const bps = line.taxRateBps ?? Number(base.default_tax_bps);
    const valuePaisa = purchaseLineValue(entered, unitCost);
    return { line, entered, unitCost, bps, valuePaisa, taxPaisa: inputTaxOf(valuePaisa, bps), qtyBase: toBaseQuantity(entered, parseQuantity(base.factor_to_base)) };
  });
  const subtotal = worked.reduce((sum, row) => sum + row.valuePaisa, 0);
  const tax = worked.reduce((sum, row) => sum + row.taxPaisa, 0);
  const payload = {
    business_id: businessId, receipt_id: input.receiptId, reason: input.reason, subtotal_paisa: subtotal, tax_paisa: tax, total_paisa: subtotal + tax,
    lines: worked.map((row) => ({
      receipt_line_id: row.line.receiptLineId, qty_entered: formatQuantity(row.entered), qty_base: formatQuantity(row.qtyBase), unit_cost_paisa: row.unitCost,
      line_value_paisa: row.valuePaisa, tax_rate_bps: row.bps, tax_paisa: row.taxPaisa,
    })),
  };
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select post_purchase_return(${JSON.stringify(payload)}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const mapped = mapFunctionError(context, error);
    if (mapped) return mapped;
    throw error;
  }
  await auditPrincipal(context, principal, "purchase_return", id, "post", null, { receiptId: input.receiptId, totalPaisa: subtotal + tax });
  return context.json(await loadReturn(businessId, id), 201);
});

payablesRoutes.get("/purchase-returns", costs, requirePermission("purchasing.view"), async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const supplierId = uuidParam(context.req.query("supplierId"));
  const search = context.req.query("q")?.trim();
  const filters = [sql`r.business_id = ${businessId}`];
  if (supplierId) filters.push(sql`r.supplier_id = ${supplierId}`);
  if (search) filters.push(sql`(r.number ilike ${`%${escapeLike(search)}%`} or s.name ilike ${`%${escapeLike(search)}%`} or g.number ilike ${`%${escapeLike(search)}%`})`);
  const rows = await db.execute(sql`
    select r.id, r.number, r.posted_at, r.total_paisa, r.reason, s.name as supplier_name, g.number as receipt_number, count(*) over () as total
    from purchase_returns r join suppliers s on s.id = r.supplier_id join goods_receipts g on g.id = r.receipt_id where ${sql.join(filters, sql` and `)}
    order by r.posted_at desc, r.number desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id), number: String(row.number), postedAt: iso(row.posted_at), totalPaisa: paisa(row.total_paisa), reason: String(row.reason),
      supplierName: String(row.supplier_name), receiptNumber: String(row.receipt_number),
    })),
    page, pageSize, total: rows.length ? paisa(rows[0].total) : 0,
  });
});

payablesRoutes.get("/purchase-returns/:id", costs, requirePermission("purchasing.view"), async (context) => {
  const found = await loadReturn(getPrincipal(context).businessId!, paramId(context));
  return found ? context.json(found) : apiError(context, 404, "NOT_FOUND", "Purchase return not found");
});
