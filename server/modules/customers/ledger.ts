import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { customers, terminals, userBranches } from "../../../db/schema";
import { customerPaymentSchema } from "../../../shared/schemas/customerPayments";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";

// The customer's khata: what they owe, how it came about, and receiving money against it (FR-CUS-02..06).

export const customerLedgerRoutes = new Hono();

const viewLedger = requirePermission("customers.ledger");
const paisa = (value: unknown) => Number(value);

async function loadCustomer(businessId: string, id: string) {
  const [row] = await db.select({ id: customers.id, name: customers.name, balancePaisa: customers.balancePaisa, creditLimitPaisa: customers.creditLimitPaisa, termsDays: customers.termsDays })
    .from(customers).where(and(eq(customers.id, id), eq(customers.businessId, businessId))).limit(1);
  return row ?? null;
}

/** Invoices with something still owing, oldest first, and whether each is past the customer's payment terms. */
async function openInvoices(businessId: string, customerId: string, termsDays: number) {
  const rows = await db.execute(sql`
    select invoice_id, number, posted_at, total_paisa, outstanding_paisa,
           (${termsDays} > 0 and posted_at + make_interval(days => ${termsDays}) < now()) as overdue
    from customer_open_invoices(${businessId}::uuid, ${customerId}::uuid)
  `);
  return rows.map((row) => ({
    invoiceId: String(row.invoice_id), number: String(row.number), postedAt: row.posted_at, totalPaisa: paisa(row.total_paisa),
    outstandingPaisa: paisa(row.outstanding_paisa), overdue: Boolean(row.overdue),
  }));
}

/** The khata page: the balance, the open invoices and the ledger newest first, each entry with the balance after it. */
customerLedgerRoutes.get("/customers/:id/ledger", viewLedger, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const customer = await loadCustomer(businessId, paramId(context));
  if (!customer) return apiError(context, 404, "NOT_FOUND", "Customer not found");
  const page = Math.max(1, Math.trunc(Number(context.req.query("page") ?? 1)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(context.req.query("pageSize") ?? 25)) || 25));
  const entries = await db.execute(sql`
    select * from (
      select l.id, l.seq, l.doc_type, l.doc_id, l.doc_number, l.memo, l.debit_paisa, l.credit_paisa, l.entry_at,
             sum(l.debit_paisa - l.credit_paisa) over (order by l.seq) as balance_after, count(*) over () as total
      from party_ledger l
      where l.business_id = ${businessId} and l.party_type = 'customer' and l.party_id = ${customer.id}
    ) x order by seq desc limit ${pageSize} offset ${(page - 1) * pageSize}
  `);
  return context.json({
    customer: { id: customer.id, name: customer.name, balancePaisa: customer.balancePaisa, creditLimitPaisa: customer.creditLimitPaisa, termsDays: customer.termsDays },
    openInvoices: await openInvoices(businessId, customer.id, customer.termsDays),
    entries: entries.map((row) => ({
      id: String(row.id), docType: String(row.doc_type), docId: String(row.doc_id), docNumber: String(row.doc_number), memo: String(row.memo),
      debitPaisa: paisa(row.debit_paisa), creditPaisa: paisa(row.credit_paisa), at: row.entry_at, balanceAfterPaisa: paisa(row.balance_after),
    })),
    page, pageSize, total: entries.length ? paisa(entries[0].total) : 0,
  });
});

/** Rule violations raised by the payment function. */
const paymentErrors: Array<[prefix: string, status: 409 | 422, code: string]> = [
  ["SHIFT_NOT_OPEN", 409, "SHIFT_NOT_OPEN"],
  ["INVALID_CUSTOMER", 422, "INVALID_CUSTOMER"],
  ["INVALID_PAYMENT", 422, "INVALID_PAYMENT"],
  ["INVALID_ALLOCATION", 422, "INVALID_ALLOCATION"],
];

/** Receives money from a customer (cash into the open shift of this terminal) and settles their oldest invoices, or the ones chosen. */
customerLedgerRoutes.post("/customer-payments", requirePermission("customers.receive_payment"), idempotent(), validateJson(customerPaymentSchema), async (context) => {
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
    // The back office has no till: the payment belongs to the person's own branch, and cash is refused (no drawer to put it in).
    const [mine] = principal.userId ? await db.select({ branchId: userBranches.branchId }).from(userBranches).where(eq(userBranches.userId, principal.userId)).limit(1) : [];
    if (!mine) return apiError(context, 400, "TERMINAL_REQUIRED", "Receive payments on a registered terminal or from a user with a branch");
    branchId = mine.branchId;
  }

  const customer = await loadCustomer(businessId, input.customerId);
  if (!customer) return apiError(context, 422, "INVALID_CUSTOMER", "This customer is not available");

  const payload = {
    business_id: businessId, branch_id: branchId, terminal_id: terminalId, shift_id: shiftId, customer_id: input.customerId, method_id: input.methodId,
    amount_paisa: input.amountPaisa, reference: input.reference, note: input.note,
    allocate: input.allocations ? "manual" : "oldest",
    allocations: (input.allocations ?? []).map((allocation) => ({ invoice_id: allocation.invoiceId, amount_paisa: allocation.amountPaisa })),
  };
  let paymentId: string;
  try {
    paymentId = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select post_customer_payment(${JSON.stringify(payload)}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const message = dbErrorMessage(error);
    const known = paymentErrors.find(([prefix]) => message.includes(prefix));
    if (known) return apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message);
    throw error;
  }

  await auditPrincipal(context, principal, "customer_payment", paymentId, "post", null, { customerId: input.customerId, amountPaisa: input.amountPaisa });
  return context.json(await loadPayment(businessId, paymentId), 201);
});

async function loadPayment(businessId: string, id: string) {
  const [payment] = await db.execute(sql`
    select p.*, c.name as customer_name, c.balance_paisa as customer_balance, b.name as branch_name, u.display_name as received_by
    from customer_payments p join customers c on c.id = p.customer_id join branches b on b.id = p.branch_id left join users u on u.id = p.created_by
    where p.business_id = ${businessId} and p.id = ${id}
  `);
  if (!payment) return null;
  const allocations = await db.execute(sql`
    select a.invoice_id, a.amount_paisa, i.number from payment_allocations a join sales_invoices i on i.id = a.invoice_id
    where a.business_id = ${businessId} and a.source_id = ${id} order by i.posted_at, i.id
  `);
  return {
    id: String(payment.id), number: String(payment.number), postedAt: payment.posted_at, customerId: String(payment.customer_id),
    customerName: String(payment.customer_name), branchName: String(payment.branch_name), receivedBy: payment.received_by ?? null,
    methodCode: String(payment.method_code), methodName: String(payment.method_name), amountPaisa: paisa(payment.amount_paisa),
    reference: String(payment.reference), note: String(payment.note),
    // The customer's balance now, after this payment (a later sale would change it).
    customerBalancePaisa: paisa(payment.customer_balance),
    allocations: allocations.map((row) => ({ invoiceId: String(row.invoice_id), number: String(row.number), amountPaisa: paisa(row.amount_paisa) })),
  };
}

customerLedgerRoutes.get("/customer-payments/:id", viewLedger, async (context) => {
  const payment = await loadPayment(getPrincipal(context).businessId!, paramId(context));
  return payment ? context.json(payment) : apiError(context, 404, "NOT_FOUND", "Payment not found");
});
