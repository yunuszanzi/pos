import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { businessSettings, customers, terminals, userBranches } from "../../../db/schema";
import { ageLedger, summariseStatement, type KhataEntry } from "../../../shared/khata";
import { customerPaymentSchema } from "../../../shared/schemas/customerPayments";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { escapeLike } from "../products/service";
import { analyseOpeningBalanceFile, OpeningBalanceFileError } from "./openingBalances";

// The customer's khata: what they owe, how it came about, and receiving money against it (FR-CUS-02..06).

export const customerLedgerRoutes = new Hono();

const viewLedger = requirePermission("customers.ledger");
const paisa = (value: unknown) => Number(value);

async function loadCustomer(businessId: string, id: string) {
  const [row] = await db.select({
    id: customers.id, name: customers.name, phone: customers.phone, whatsapp: customers.whatsapp, balancePaisa: customers.balancePaisa,
    creditLimitPaisa: customers.creditLimitPaisa, termsDays: customers.termsDays,
  })
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
    customer: { id: customer.id, name: customer.name, phone: customer.phone, whatsapp: customer.whatsapp, balancePaisa: customer.balancePaisa, creditLimitPaisa: customer.creditLimitPaisa, termsDays: customer.termsDays },
    openInvoices: await openInvoices(businessId, customer.id, customer.termsDays),
    entries: entries.map((row) => ({
      id: String(row.id), docType: String(row.doc_type), docId: String(row.doc_id), docNumber: String(row.doc_number), memo: String(row.memo),
      debitPaisa: paisa(row.debit_paisa), creditPaisa: paisa(row.credit_paisa), at: row.entry_at, balanceAfterPaisa: paisa(row.balance_after),
    })),
    page, pageSize, total: entries.length ? paisa(entries[0].total) : 0,
  });
});

// ---------------------------------------------------------------- statements and ageing

const maxStatementEntries = 2000;
const isDate = (text: string) => {
  const date = new Date(`${text}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
};

async function timezoneOf(businessId: string) {
  const [settings] = await db.select({ timezone: businessSettings.timezone }).from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1);
  return settings?.timezone ?? "Asia/Karachi";
}

/**
 * A customer's statement for a period: the balance at the start, every entry in the period with the balance after it, and the
 * totals. Closing = opening + invoices − payments − returns + refunds (shared/khata.ts). Days are the business's days.
 * Not paginated, because a statement is printed whole; a period with more than 2,000 entries is refused.
 */
customerLedgerRoutes.get("/customers/:id/statement", viewLedger, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const [customer] = await db.select({
    id: customers.id, name: customers.name, businessName: customers.businessName, phone: customers.phone, whatsapp: customers.whatsapp,
    address: customers.address, balancePaisa: customers.balancePaisa,
  }).from(customers).where(and(eq(customers.id, paramId(context)), eq(customers.businessId, businessId))).limit(1);
  if (!customer) return apiError(context, 404, "NOT_FOUND", "Customer not found");

  const timezone = await timezoneOf(businessId);
  const [today] = await db.execute<{ today: string; month: string }>(sql`
    select to_char(now() at time zone ${timezone}, 'YYYY-MM-DD') as today, to_char(date_trunc('month', now() at time zone ${timezone}), 'YYYY-MM-DD') as month`);
  const from = context.req.query("from") || today.month;
  const to = context.req.query("to") || today.today;
  if (!isDate(from) || !isDate(to)) return apiError(context, 400, "INVALID_PERIOD", "Dates must be written yyyy-mm-dd");
  if (from > to) return apiError(context, 400, "INVALID_PERIOD", "The period must start before it ends");

  const [opening] = await db.execute<{ balance: string }>(sql`
    select coalesce(sum(debit_paisa - credit_paisa), 0) as balance from party_ledger
    where business_id = ${businessId} and party_type = 'customer' and party_id = ${customer.id}
      and entry_at < (${from}::date)::timestamp at time zone ${timezone}`);
  const rows = await db.execute(sql`
    select id, doc_type, doc_id, doc_number, memo, debit_paisa, credit_paisa, entry_at from party_ledger
    where business_id = ${businessId} and party_type = 'customer' and party_id = ${customer.id}
      and entry_at >= (${from}::date)::timestamp at time zone ${timezone} and entry_at < ((${to}::date + 1))::timestamp at time zone ${timezone}
    order by seq limit ${maxStatementEntries + 1}`);
  if (rows.length > maxStatementEntries) return apiError(context, 422, "STATEMENT_TOO_LONG", `This period has more than ${maxStatementEntries} entries. Choose a shorter period`);

  const openingPaisa = paisa(opening.balance);
  let running = openingPaisa;
  const entries = rows.map((row) => {
    const debitPaisa = paisa(row.debit_paisa);
    const creditPaisa = paisa(row.credit_paisa);
    running += debitPaisa - creditPaisa;
    return { id: String(row.id), docType: String(row.doc_type), docNumber: String(row.doc_number), memo: String(row.memo), debitPaisa, creditPaisa, at: String(new Date(row.entry_at as string).toISOString()), balanceAfterPaisa: running };
  });
  return context.json({
    customer: { id: customer.id, name: customer.name, businessName: customer.businessName, phone: customer.phone, whatsapp: customer.whatsapp, address: customer.address, balancePaisa: customer.balancePaisa },
    period: { from, to }, entries, summary: summariseStatement(openingPaisa, entries),
  });
});

/**
 * Who owes what and how old it is (FR-CUS-04): 0–30, 31–60, 61–90 and over 90 days, from the ledger (shared/khata.ts ageLedger).
 * `overdue` is true when the oldest unpaid debt is older than the customer's payment terms (30 days when they have none).
 * `?overdue=true` lists only those. Paginated; the totals cover every customer the filters match.
 */
customerLedgerRoutes.get("/customer-ageing", viewLedger, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const page = Math.max(1, Math.trunc(Number(context.req.query("page") ?? 1)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(context.req.query("pageSize") ?? 25)) || 25));
  const areaId = context.req.query("areaId");
  const area = areaId && /^[0-9a-f-]{36}$/i.test(areaId) ? sql`and c.area_id = ${areaId}` : sql``;
  const search = context.req.query("q")?.trim();
  const named = search ? sql`and (c.name ilike ${`%${escapeLike(search)}%`} or c.business_name ilike ${`%${escapeLike(search)}%`} or c.phone ilike ${`%${escapeLike(search)}%`})` : sql``;

  const people = await db.execute(sql`
    select c.id, c.name, c.business_name, c.phone, c.whatsapp, c.terms_days, c.balance_paisa from customers c
    where c.business_id = ${businessId} and c.balance_paisa <> 0 ${area} ${named}`);
  const ids = people.map((row) => String(row.id));
  const ledger = ids.length ? await db.execute(sql`
    select party_id, doc_type, debit_paisa, credit_paisa, entry_at from party_ledger
    where business_id = ${businessId} and party_type = 'customer' and party_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    order by party_id, seq`) : [];
  const byCustomer = new Map<string, KhataEntry[]>();
  for (const row of ledger) {
    const list = byCustomer.get(String(row.party_id)) ?? [];
    list.push({ docType: String(row.doc_type), debitPaisa: paisa(row.debit_paisa), creditPaisa: paisa(row.credit_paisa), at: new Date(row.entry_at as string).toISOString() });
    byCustomer.set(String(row.party_id), list);
  }

  const now = new Date();
  let rows = people.map((row) => {
    const ageing = ageLedger(byCustomer.get(String(row.id)) ?? [], now);
    const termsDays = Number(row.terms_days);
    return {
      customerId: String(row.id), name: String(row.name), businessName: String(row.business_name), phone: String(row.phone), whatsapp: String(row.whatsapp),
      termsDays, balancePaisa: paisa(row.balance_paisa), ...ageing, overdue: ageing.owedPaisa > 0 && ageing.oldestDays > (termsDays || 30),
    };
  }).filter((row) => row.owedPaisa > 0);
  if (context.req.query("overdue") === "true") rows = rows.filter((row) => row.overdue);
  rows.sort((a, b) => b.owedPaisa - a.owedPaisa || a.name.localeCompare(b.name));

  const totals = rows.reduce((sum, row) => ({
    bandsPaisa: sum.bandsPaisa.map((value, band) => value + row.bandsPaisa[band]), owedPaisa: sum.owedPaisa + row.owedPaisa,
  }), { bandsPaisa: [0, 0, 0, 0], owedPaisa: 0 });
  return context.json({ data: rows.slice((page - 1) * pageSize, page * pageSize), totals, page, pageSize, total: rows.length });
});

// ---------------------------------------------------------------- opening balances

const csvSchema = z.object({ csv: z.string().min(1).max(2_000_000) });
const canImportBalances = requirePermission("customers.manage");

customerLedgerRoutes.post("/customers-opening-balances/preview", canImportBalances, viewLedger, validateJson(csvSchema), async (context) => {
  try {
    const analysis = await analyseOpeningBalanceFile(db, getPrincipal(context).businessId!, context.req.valid("json").csv);
    return context.json({
      canImport: analysis.issues.length === 0, issues: analysis.issues,
      summary: { customers: analysis.lines.length, owedPaisa: analysis.owedPaisa, creditPaisa: analysis.creditPaisa },
    });
  } catch (error) {
    if (error instanceof OpeningBalanceFileError) return apiError(context, 400, "INVALID_CSV", error.message);
    throw error;
  }
});

/** All or nothing: the file is checked again inside the transaction, so a customer who got an entry since the preview stops the import. */
customerLedgerRoutes.post("/customers-opening-balances", canImportBalances, viewLedger, idempotent(), validateJson(csvSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  try {
    const outcome = await db.transaction(async (tx) => {
      const analysis = await analyseOpeningBalanceFile(tx, businessId, context.req.valid("json").csv);
      if (analysis.issues.length) return { issues: analysis.issues };
      const payload = { business_id: businessId, lines: analysis.lines.map((line) => ({ customer_id: line.customerId, amount_paisa: line.amountPaisa, as_of: line.asOf, note: line.note })) };
      await tx.execute(sql`select post_opening_balances(${JSON.stringify(payload)}::jsonb, ${getActorId(principal)})`);
      return { result: { customers: analysis.lines.length, owedPaisa: analysis.owedPaisa, creditPaisa: analysis.creditPaisa } };
    });
    if ("issues" in outcome) return context.json({ error: { code: "IMPORT_HAS_ERRORS", message: "Fix the listed rows and import again", details: outcome.issues } }, 422);
    await auditPrincipal(context, principal, "customer", "opening-balances", "opening_balances", null, outcome.result);
    return context.json(outcome.result, 201);
  } catch (error) {
    if (error instanceof OpeningBalanceFileError) return apiError(context, 400, "INVALID_CSV", error.message);
    if (dbErrorMessage(error).includes("OPENING_BALANCE_EXISTS")) return apiError(context, 409, "OPENING_BALANCE_EXISTS", "A customer in the file already has entries in their khata");
    throw error;
  }
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
