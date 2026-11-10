import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { allocateByValue, billTotals, inputTaxOf } from "../../../shared/purchaseBills";
import { purchaseLineValue } from "../../../shared/purchasing";
import { purchaseBillSchema } from "../../../shared/schemas/bills";
import { formatQuantity, parseQuantity, toBaseQuantity } from "../../../shared/units";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage, duplicateConflict } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { escapeLike } from "../products/service";

// Supplier bills (FR-PUR-04, FR-PUR-09): the supplier's invoice for goods already received. A bill is all about money, so every
// bill endpoint needs the permission to see costs as well as the permission to bill.

export const billRoutes = new Hono();

const bill = requirePermission("purchasing.bill");
const costs = requirePermission("products.cost.view");
const paisa = (value: unknown) => Number(value);
const quantityText = (value: unknown) => formatQuantity(parseQuantity(String(value)));
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);
const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});

const functionErrors: Array<[prefix: string, status: 409 | 422, code: string]> = [
  ["INVALID_SUPPLIER", 422, "INVALID_SUPPLIER"],
  ["INVALID_LINE", 422, "INVALID_LINE"],
  ["BILL_EXCEEDS_RECEIPT", 409, "BILL_EXCEEDS_RECEIPT"],
  ["BILL_TOTAL_MISMATCH", 422, "BILL_TOTAL_MISMATCH"],
];

async function loadBill(businessId: string, id: string) {
  const [row] = await db.execute(sql`
    select b.*, s.name as supplier_name, br.name as branch_name from purchase_bills b join suppliers s on s.id = b.supplier_id join branches br on br.id = b.branch_id
    where b.business_id = ${businessId} and b.id = ${id}`);
  if (!row) return null;
  const lines = await db.execute(sql`
    select l.*, r.number as receipt_number from purchase_bill_lines l join goods_receipt_lines rl on rl.id = l.receipt_line_id join goods_receipts r on r.id = rl.receipt_id
    where l.business_id = ${businessId} and l.bill_id = ${id} order by l.line_no`);
  const charges = await db.execute(sql`select * from purchase_bill_charges where business_id = ${businessId} and bill_id = ${id} order by line_no`);
  // What has been paid against this bill, or credited by a purchase return, and what is still owing.
  const settled = await db.execute(sql`
    select a.source_type, a.source_id, a.amount_paisa, coalesce(p.number, r.number) as number, coalesce(p.posted_at, r.posted_at) as posted_at
    from supplier_payment_allocations a left join supplier_payments p on a.source_type = 'supplier_payment' and p.id = a.source_id
    left join purchase_returns r on a.source_type = 'purchase_return' and r.id = a.source_id
    where a.business_id = ${businessId} and a.bill_id = ${id} order by coalesce(p.posted_at, r.posted_at), a.created_at`);
  const settledPaisa = settled.reduce((sum, row) => sum + paisa(row.amount_paisa), 0);
  return {
    id: String(row.id), number: String(row.number), supplierId: String(row.supplier_id), supplierName: String(row.supplier_name), branchName: String(row.branch_name),
    supplierInvoiceNo: String(row.supplier_invoice_no), billDate: day(row.bill_date), dueDate: day(row.due_date), note: String(row.note), createdAt: iso(row.created_at),
    subtotalPaisa: paisa(row.subtotal_paisa), chargesPaisa: paisa(row.charges_paisa), taxPaisa: paisa(row.tax_paisa), totalPaisa: paisa(row.total_paisa),
    settledPaisa, outstandingPaisa: paisa(row.total_paisa) - settledPaisa,
    settlements: settled.map((row) => ({ kind: String(row.source_type), id: String(row.source_id), number: String(row.number), at: iso(row.posted_at), amountPaisa: paisa(row.amount_paisa) })),
    lines: lines.map((line) => ({
      id: String(line.id), lineNo: Number(line.line_no), receiptLineId: String(line.receipt_line_id), receiptNumber: String(line.receipt_number),
      productName: String(line.product_name), variantName: String(line.variant_name), sku: String(line.sku), unitName: String(line.unit_name),
      quantity: quantityText(line.qty_entered), qtyBase: quantityText(line.qty_base), unitCostPaisa: paisa(line.unit_cost_paisa), lineValuePaisa: paisa(line.line_value_paisa),
      taxRateBps: Number(line.tax_rate_bps), taxPaisa: paisa(line.tax_paisa), chargeSharePaisa: paisa(line.charge_share_paisa),
      receiptCostPerBasePaisa: paisa(line.receipt_cost_per_base_paisa), absorbedPaisa: paisa(line.absorbed_paisa),
    })),
    charges: charges.map((charge) => ({ id: String(charge.id), description: String(charge.description), amountPaisa: paisa(charge.amount_paisa) })),
  };
}

billRoutes.get("/purchase-bills", costs, bill, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const supplierId = context.req.query("supplierId");
  const search = context.req.query("q")?.trim();
  const filters = [sql`b.business_id = ${businessId}`];
  if (supplierId && /^[0-9a-f-]{36}$/i.test(supplierId)) filters.push(sql`b.supplier_id = ${supplierId}`);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    filters.push(sql`(b.number ilike ${pattern} or b.supplier_invoice_no ilike ${pattern} or s.name ilike ${pattern})`);
  }
  const rows = await db.execute(sql`
    select b.id, b.number, b.supplier_invoice_no, b.bill_date, b.due_date, b.total_paisa, b.tax_paisa, s.name as supplier_name, count(*) over () as total,
           b.total_paisa - coalesce((select sum(x.amount_paisa) from supplier_payment_allocations x where x.bill_id = b.id), 0) as outstanding
    from purchase_bills b join suppliers s on s.id = b.supplier_id
    where ${sql.join(filters, sql` and `)}
    order by b.bill_date desc, b.number desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id), number: String(row.number), supplierInvoiceNo: String(row.supplier_invoice_no), billDate: day(row.bill_date), dueDate: day(row.due_date),
      supplierName: String(row.supplier_name), totalPaisa: paisa(row.total_paisa), taxPaisa: paisa(row.tax_paisa), outstandingPaisa: paisa(row.outstanding),
    })),
    page, pageSize, total: rows.length ? paisa(rows[0].total) : 0,
  });
});

billRoutes.get("/purchase-bills/:id", costs, bill, async (context) => {
  const found = await loadBill(getPrincipal(context).businessId!, paramId(context));
  return found ? context.json(found) : apiError(context, 404, "NOT_FOUND", "Bill not found");
});

/**
 * The supplier's goods that have been received and not yet billed, oldest first, for the bill form: each with what is left to bill
 * (in the unit it was received in) and the price the receipt carried.
 */
billRoutes.get("/billable-receipt-lines", costs, bill, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const supplierId = context.req.query("supplierId");
  if (!supplierId || !/^[0-9a-f-]{36}$/i.test(supplierId)) return apiError(context, 400, "SUPPLIER_REQUIRED", "Choose a supplier");
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const rows = await db.execute(sql`
    select rl.id, rl.line_no, rl.product_name, rl.variant_name, rl.sku, rl.unit_name, rl.qty_entered, rl.qty_base, rl.billed_base, rl.factor_to_base, rl.unit_cost_paisa,
           r.id as receipt_id, r.number as receipt_number, r.received_at, r.supplier_ref, count(*) over () as total
    from goods_receipt_lines rl join goods_receipts r on r.id = rl.receipt_id
    where rl.business_id = ${businessId} and r.supplier_id = ${supplierId} and rl.billed_base < rl.qty_base
    order by r.received_at, r.number, rl.line_no limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => {
      const factor = parseQuantity(String(row.factor_to_base));
      const leftBase = parseQuantity(String(row.qty_base)) - parseQuantity(String(row.billed_base));
      return {
        id: String(row.id), lineNo: Number(row.line_no), receiptId: String(row.receipt_id), receiptNumber: String(row.receipt_number), receivedAt: iso(row.received_at),
        supplierRef: String(row.supplier_ref), productName: String(row.product_name), variantName: String(row.variant_name), sku: String(row.sku), unitName: String(row.unit_name),
        quantity: quantityText(row.qty_entered), factorToBase: quantityText(row.factor_to_base),
        // Left to bill, in the unit it was received in (rounded down to a whole thousandth).
        unbilledQuantity: formatQuantity(Math.floor((leftBase * 1000) / factor)), unitCostPaisa: paisa(row.unit_cost_paisa),
      };
    }),
    page, pageSize, total: rows.length ? paisa(rows[0].total) : 0,
  });
});

function mapFunctionError(context: Context, error: unknown): Response | null {
  const message = dbErrorMessage(error);
  const known = functionErrors.find(([prefix]) => message.includes(prefix));
  return known ? apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message) : null;
}

/**
 * Enters a supplier's bill: the price on their invoice for goods already received, plus freight and tax. The sums (line values, input
 * tax, each line's share of the charges, the total) are worked out here with shared/purchaseBills.ts and checked again by the database.
 */
billRoutes.post("/purchase-bills", costs, bill, idempotent(), validateJson(purchaseBillSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  const written = new Date(`${input.billDate}T00:00:00Z`);
  if (Number.isNaN(written.getTime()) || written.toISOString().slice(0, 10) !== input.billDate) return apiError(context, 400, "INVALID_DATE", "The bill date is not a real date");

  const facts = await db.execute<{ id: string; factor_to_base: string }>(sql`
    select id, factor_to_base::text as factor_to_base from goods_receipt_lines
    where business_id = ${businessId} and id in (${sql.join(input.lines.map((line) => sql`${line.receiptLineId}::uuid`), sql`, `)})`);
  const factorOf = new Map(facts.map((row) => [row.id, parseQuantity(row.factor_to_base)]));
  if (input.lines.some((line) => !factorOf.has(line.receiptLineId))) return apiError(context, 422, "INVALID_LINE", "A line is not a received item");

  const worked = input.lines.map((line) => {
    const entered = parseQuantity(line.quantity);
    const valuePaisa = purchaseLineValue(entered, line.unitCostPaisa);
    return { line, entered, qtyBase: toBaseQuantity(entered, factorOf.get(line.receiptLineId)!), valuePaisa, taxPaisa: inputTaxOf(valuePaisa, line.taxRateBps) };
  });
  const chargeTotal = input.charges.reduce((sum, charge) => sum + charge.amountPaisa, 0);
  const shares = allocateByValue(chargeTotal, worked.map((row) => row.valuePaisa));
  const totals = billTotals(worked, input.charges.map((charge) => charge.amountPaisa));
  const payload = {
    business_id: businessId, supplier_id: input.supplierId, supplier_invoice_no: input.supplierInvoiceNo, bill_date: input.billDate, note: input.note,
    subtotal_paisa: totals.subtotalPaisa, charges_paisa: totals.chargesPaisa, tax_paisa: totals.taxPaisa, total_paisa: totals.totalPaisa,
    lines: worked.map((row, index) => ({
      receipt_line_id: row.line.receiptLineId, qty_entered: formatQuantity(row.entered), qty_base: formatQuantity(row.qtyBase), unit_cost_paisa: row.line.unitCostPaisa,
      line_value_paisa: row.valuePaisa, tax_rate_bps: row.line.taxRateBps, tax_paisa: row.taxPaisa, charge_share_paisa: shares[index],
    })),
    charges: input.charges.map((charge) => ({ description: charge.description, amount_paisa: charge.amountPaisa })),
  };

  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select post_purchase_bill(${JSON.stringify(payload)}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const duplicate = duplicateConflict(context, error);
    if (duplicate) return duplicate;
    const mapped = mapFunctionError(context, error);
    if (mapped) return mapped;
    throw error;
  }
  await auditPrincipal(context, principal, "purchase_bill", id, "post", null, { supplierId: input.supplierId, supplierInvoiceNo: input.supplierInvoiceNo, totalPaisa: totals.totalPaisa });
  return context.json(await loadBill(businessId, id), 201);
});
