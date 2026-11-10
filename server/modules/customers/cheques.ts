import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { businessSettings, customers, terminals, userBranches } from "../../../db/schema";
import { bounceChequeSchema, chequeStatuses, receiveChequeSchema } from "../../../shared/schemas/cheques";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage, duplicateConflict } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { escapeLike } from "../products/service";

// Cheques from customers, including post-dated ones (FR-CUS-09). Taking a cheque records the payment at once; a bounce takes it back.

export const chequeRoutes = new Hono();

const view = requirePermission("customers.ledger");
const handle = requirePermission("customers.cheques");
const paisa = (value: unknown) => Number(value);

async function timezoneOf(businessId: string) {
  const [settings] = await db.select({ timezone: businessSettings.timezone }).from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1);
  return settings?.timezone ?? "Asia/Karachi";
}

/** Loads cheques with their customer, and whether each in-hand cheque has reached the date written on it (the business's today). */
async function chequeRows(businessId: string, timezone: string, where: ReturnType<typeof sql>, tail: ReturnType<typeof sql> = sql``) {
  const rows = await db.execute(sql`
    select q.*, c.name as customer_name, c.balance_paisa as customer_balance, count(*) over () as total,
           (q.status = 'received' and q.cheque_date <= (now() at time zone ${timezone})::date) as due
    from cheques q join customers c on c.id = q.customer_id
    where q.business_id = ${businessId} ${where} ${tail}`);
  return rows.map((row) => ({
    id: String(row.id), customerId: String(row.customer_id), customerName: String(row.customer_name), chequeNo: String(row.cheque_no), bank: String(row.bank),
    amountPaisa: paisa(row.amount_paisa), chequeDate: String(row.cheque_date).slice(0, 10), status: String(row.status), due: Boolean(row.due),
    note: String(row.note), bounceReason: String(row.bounce_reason), paymentId: String(row.payment_id),
    receivedAt: new Date(row.received_at as string).toISOString(),
    depositedAt: row.deposited_at ? new Date(row.deposited_at as string).toISOString() : null,
    clearedAt: row.cleared_at ? new Date(row.cleared_at as string).toISOString() : null,
    bouncedAt: row.bounced_at ? new Date(row.bounced_at as string).toISOString() : null,
    customerBalancePaisa: paisa(row.customer_balance), total: paisa(row.total),
  }));
}

const present = ({ total, ...cheque }: Awaited<ReturnType<typeof chequeRows>>[number]) => { void total; return cheque; };

chequeRoutes.get("/cheques", view, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const timezone = await timezoneOf(businessId);
  const page = Math.max(1, Math.trunc(Number(context.req.query("page") ?? 1)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(context.req.query("pageSize") ?? 25)) || 25));
  const status = context.req.query("status") ?? "";
  const filters = [sql``];
  if ((chequeStatuses as readonly string[]).includes(status)) filters.push(sql`and q.status = ${status}`);
  if (context.req.query("due") === "true") filters.push(sql`and q.status = 'received' and q.cheque_date <= (now() at time zone ${timezone})::date`);
  const customerId = context.req.query("customerId");
  if (customerId && /^[0-9a-f-]{36}$/i.test(customerId)) filters.push(sql`and q.customer_id = ${customerId}`);
  const search = context.req.query("q")?.trim();
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    filters.push(sql`and (q.cheque_no ilike ${pattern} or q.bank ilike ${pattern} or c.name ilike ${pattern})`);
  }
  // Cheques still to be dealt with come soonest-first; finished ones newest-first.
  const open = status === "received" || status === "deposited" || context.req.query("due") === "true";
  const rows = await chequeRows(businessId, timezone, sql.join(filters, sql` `),
    open ? sql`order by q.cheque_date, q.id limit ${pageSize} offset ${(page - 1) * pageSize}` : sql`order by q.received_at desc, q.id limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({ data: rows.map(present), page, pageSize, total: rows[0]?.total ?? 0 });
});

chequeRoutes.get("/cheques/:id", view, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const [row] = await chequeRows(businessId, await timezoneOf(businessId), sql`and q.id = ${paramId(context)}`);
  return row ? context.json(present(row)) : apiError(context, 404, "NOT_FOUND", "Cheque not found");
});

const receiveErrors: Array<[prefix: string, status: 422, code: string]> = [
  ["INVALID_CUSTOMER", 422, "INVALID_CUSTOMER"],
  ["INVALID_PAYMENT", 422, "INVALID_PAYMENT"],
];

/** Takes a cheque: it settles the customer's oldest invoices now, and stays "in hand" until it is deposited. */
chequeRoutes.post("/cheques", requirePermission("customers.receive_payment"), idempotent(), validateJson(receiveChequeSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  const written = new Date(`${input.chequeDate}T00:00:00Z`);
  if (Number.isNaN(written.getTime()) || written.toISOString().slice(0, 10) !== input.chequeDate) return apiError(context, 400, "INVALID_DATE", "The cheque date is not a real date");

  let branchId: string | null = null;
  if (principal.terminalId) {
    const [terminal] = await db.select({ branchId: terminals.branchId }).from(terminals)
      .where(and(eq(terminals.id, principal.terminalId), eq(terminals.businessId, businessId), eq(terminals.active, true))).limit(1);
    branchId = terminal?.branchId ?? null;
  }
  if (!branchId && principal.userId) {
    const [mine] = await db.select({ branchId: userBranches.branchId }).from(userBranches).where(eq(userBranches.userId, principal.userId)).limit(1);
    branchId = mine?.branchId ?? null;
  }
  if (!branchId) return apiError(context, 400, "TERMINAL_REQUIRED", "Take cheques on a registered terminal or from a user with a branch");

  const [customer] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, input.customerId), eq(customers.businessId, businessId))).limit(1);
  if (!customer) return apiError(context, 422, "INVALID_CUSTOMER", "This customer is not available");

  const payload = {
    business_id: businessId, branch_id: branchId, customer_id: input.customerId, cheque_no: input.chequeNo, bank: input.bank,
    amount_paisa: input.amountPaisa, cheque_date: input.chequeDate, note: input.note,
  };
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select receive_cheque(${JSON.stringify(payload)}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const duplicate = duplicateConflict(context, error);
    if (duplicate) return duplicate;
    const message = dbErrorMessage(error);
    const known = receiveErrors.find(([prefix]) => message.includes(prefix));
    if (known) return apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message);
    throw error;
  }
  await auditPrincipal(context, principal, "cheque", id, "receive", null, { customerId: input.customerId, chequeNo: input.chequeNo, bank: input.bank, amountPaisa: input.amountPaisa });
  const [created] = await chequeRows(businessId, await timezoneOf(businessId), sql`and q.id = ${id}`);
  return context.json(present(created), 201);
});

const statusErrors: Array<[prefix: string, status: 404 | 409 | 422, code: string]> = [
  ["NOT_FOUND", 404, "NOT_FOUND"],
  ["INVALID_TRANSITION", 409, "INVALID_TRANSITION"],
  ["REASON_REQUIRED", 422, "REASON_REQUIRED"],
];

async function changeStatus(context: Context, action: "deposit" | "clear" | "bounce", status: "deposited" | "cleared" | "bounced", reason: string) {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_cheque_status(${businessId}::uuid, ${id}::uuid, ${status}, ${reason}, ${getActorId(principal)})`);
    });
  } catch (error) {
    const message = dbErrorMessage(error);
    const known = statusErrors.find(([prefix]) => message.includes(prefix));
    if (known) return apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?s*/, "") || message);
    throw error;
  }
  await auditPrincipal(context, principal, "cheque", id, action, null, { status, ...(reason ? { reason } : {}) });
  const [row] = await chequeRows(businessId, await timezoneOf(businessId), sql`and q.id = ${id}`);
  return context.json(present(row));
}

chequeRoutes.post("/cheques/:id/deposit", handle, idempotent(), (context) => changeStatus(context, "deposit", "deposited", ""));
chequeRoutes.post("/cheques/:id/clear", handle, idempotent(), (context) => changeStatus(context, "clear", "cleared", ""));
/** A bounce puts the amount back on the khata and re-opens the invoices the cheque had settled. */
chequeRoutes.post("/cheques/:id/bounce", handle, idempotent(), validateJson(bounceChequeSchema), (context) =>
  changeStatus(context, "bounce", "bounced", context.req.valid("json").reason));
