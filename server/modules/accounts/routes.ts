import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { accountEntrySchema, accountSchema, accountTransferSchema, accountUpdateSchema } from "../../../shared/schemas/accounts";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { conflictOrThrow, dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { resolveBranchId } from "../sales/location";

// Cash boxes, bank accounts and wallets (FR-CSH-06). The balance is the sum of an append-only list of entries.

export const accountRoutes = new Hono();

const view = requirePermission("accounts.view");
const manage = requirePermission("accounts.manage");
const paisa = (value: unknown) => Number(value);
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});
const dateParam = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);

export const accountErrors: Array<[prefix: string, status: 404 | 409 | 422, code: string]> = [
  ["NOT_FOUND", 404, "NOT_FOUND"],
  ["INVALID_AMOUNT", 422, "INVALID_AMOUNT"],
  ["INVALID_DATE", 422, "INVALID_DATE"],
  ["INVALID_BRANCH", 422, "INVALID_BRANCH"],
  ["INVALID_ACCOUNT", 422, "INVALID_ACCOUNT"],
  ["INVALID_CATEGORY", 422, "INVALID_CATEGORY"],
  ["REASON_REQUIRED", 422, "REASON_REQUIRED"],
  ["SHIFT_NOT_OPEN", 409, "SHIFT_NOT_OPEN"],
  ["ALREADY_REVERSED", 409, "ALREADY_REVERSED"],
  ["DAY_CLOSED", 409, "DAY_CLOSED"],
];
export function mapAccountError(context: Context, error: unknown): Response | null {
  const message = dbErrorMessage(error);
  const known = accountErrors.find(([prefix]) => message.includes(prefix));
  return known ? apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message) : null;
}

const accountOf = (row: Record<string, unknown>) => ({
  id: String(row.id), name: String(row.name), kind: String(row.kind), active: Boolean(row.active), balancePaisa: paisa(row.balance_paisa),
  // A payment method this account receives money for (JazzCash, Bank transfer...), if any.
  methods: Array.isArray(row.methods) ? (row.methods as unknown[]).map(String) : [],
});

accountRoutes.get("/accounts", view, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const rows = await db.execute(sql`
    select a.*, coalesce((select array_agg(m.name order by m.sort_order) from payment_methods m where m.account_id = a.id and m.business_id = a.business_id), '{}') as methods
    from accounts a where a.business_id = ${businessId} order by a.active desc, a.kind, lower(a.name)`);
  return context.json({ data: rows.map(accountOf), totalPaisa: rows.filter((row) => row.active).reduce((sum, row) => sum + paisa(row.balance_paisa), 0) });
});

accountRoutes.post("/accounts", manage, validateJson(accountSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  const actor = getActorId(principal);
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`insert into accounts (business_id, name, kind, created_by, updated_by) values (${businessId}, ${input.name}, ${input.kind}, ${actor}, ${actor}) returning id`);
      if (input.openingBalancePaisa !== 0) {
        await tx.execute(sql`insert into account_entries (business_id, account_id, amount_paisa, doc_type, memo, created_by) values (${businessId}, ${row.id}, ${input.openingBalancePaisa}, 'opening', 'Opening balance', ${actor})`);
      }
      return row.id;
    });
    await auditPrincipal(context, principal, "account", id, "create", null, { name: input.name, kind: input.kind, openingBalancePaisa: input.openingBalancePaisa });
    const [row] = await db.execute(sql`select * from accounts where id = ${id}`);
    return context.json(accountOf(row), 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

accountRoutes.put("/accounts/:id", manage, validateJson(accountUpdateSchema), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const input = context.req.valid("json");
  try {
    const [row] = await db.execute(sql`update accounts set name = ${input.name}, active = ${input.active}, updated_by = ${getActorId(principal)}, updated_at = now() where id = ${id} and business_id = ${principal.businessId!} returning *`);
    if (!row) return apiError(context, 404, "NOT_FOUND", "Account not found");
    await auditPrincipal(context, principal, "account", id, "update", null, { name: input.name, active: input.active });
    return context.json(accountOf(row));
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

/** One account's entries, newest first, with the running balance after each (so it reads as a bank book). */
accountRoutes.get("/accounts/:id/entries", view, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const id = paramId(context);
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const from = dateParam(context.req.query("from"));
  const to = dateParam(context.req.query("to"));
  const [account] = await db.execute(sql`select * from accounts where id = ${id} and business_id = ${businessId}`);
  if (!account) return apiError(context, 404, "NOT_FOUND", "Account not found");
  const rows = await db.execute(sql`
    with ordered as (
      select e.*, sum(e.amount_paisa) over (order by e.entry_date, e.created_at, e.id) as running_paisa
      from account_entries e where e.account_id = ${id} and e.business_id = ${businessId}
    )
    select *, count(*) over () as total from ordered
    where true ${from ? sql`and entry_date >= ${from}::date` : sql``} ${to ? sql`and entry_date <= ${to}::date` : sql``}
    order by entry_date desc, created_at desc, id desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    account: accountOf(account),
    data: rows.map((row) => ({
      id: String(row.id), entryDate: day(row.entry_date), amountPaisa: paisa(row.amount_paisa), runningPaisa: paisa(row.running_paisa), docType: String(row.doc_type),
      docId: row.doc_id ? String(row.doc_id) : null, docNumber: String(row.doc_number), memo: String(row.memo), createdAt: iso(row.created_at),
    })),
    page, pageSize, total: rows.length ? paisa(rows[0].total) : 0,
  });
});

/** A deposit or withdrawal that is not a transfer or an expense: a cheque cleared, a bank charge, interest earned. */
accountRoutes.post("/accounts/:id/entries", manage, idempotent(), validateJson(accountEntrySchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  const input = context.req.valid("json");
  const entryDate = input.entryDate ?? null;
  const [today] = await db.execute<{ d: string }>(sql`select ((now() at time zone 'Asia/Karachi')::date)::text as d`);
  if (entryDate && entryDate > today.d) return apiError(context, 422, "INVALID_DATE", "An entry cannot be dated in the future");
  const signed = input.direction === "deposit" ? input.amountPaisa : -input.amountPaisa;
  const entry = await db.transaction(async (tx) => {
    const [account] = await tx.execute(sql`select id from accounts where id = ${id} and business_id = ${businessId} and active for update`);
    if (!account) return null;
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into account_entries (business_id, account_id, entry_date, amount_paisa, doc_type, memo, created_by)
      values (${businessId}, ${id}, coalesce(${entryDate}::date, (now() at time zone 'Asia/Karachi')::date), ${signed}, ${input.direction}, ${input.memo}, ${getActorId(principal)}) returning id`);
    return row.id;
  });
  if (!entry) return apiError(context, 404, "NOT_FOUND", "Account not found");
  await auditPrincipal(context, principal, "account", id, input.direction, null, { amountPaisa: input.amountPaisa, memo: input.memo });
  const [account] = await db.execute(sql`select * from accounts where id = ${id}`);
  return context.json({ account: accountOf(account), entryId: entry }, 201);
});

accountRoutes.post("/account-transfers", manage, idempotent(), validateJson(accountTransferSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  // A deposit from the register belongs to the branch of that shift; between accounts, to the branch of the request.
  let branchId: string | null = null;
  if (input.fromShiftId) {
    const [shift] = await db.execute<{ branch_id: string }>(sql`select branch_id from shifts where id = ${input.fromShiftId} and business_id = ${businessId}`);
    branchId = shift?.branch_id ?? null;
  } else {
    branchId = await resolveBranchId(businessId, undefined, principal.terminalId);
  }
  if (!branchId) return apiError(context, 422, "INVALID_BRANCH", "This branch is not available");
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select post_account_transfer(${JSON.stringify({
        business_id: businessId, branch_id: branchId, amount_paisa: input.amountPaisa, from_account_id: input.fromAccountId, from_shift_id: input.fromShiftId,
        to_account_id: input.toAccountId, transfer_date: input.transferDate, memo: input.memo,
      })}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const mapped = mapAccountError(context, error);
    if (mapped) return mapped;
    throw error;
  }
  await auditPrincipal(context, principal, "account_transfer", id, "post", null, { amountPaisa: input.amountPaisa });
  const [transfer] = await db.execute(sql`select * from account_transfers where id = ${id}`);
  const accounts = await db.execute(sql`select * from accounts where business_id = ${businessId} and id in (${sql.join([input.fromAccountId, input.toAccountId].filter((value): value is string => Boolean(value)).map((value) => sql`${value}::uuid`), sql`, `)})`);
  return context.json({ transfer: { id, number: String(transfer.number), transferDate: day(transfer.transfer_date), amountPaisa: paisa(transfer.amount_paisa), memo: String(transfer.memo) }, accounts: accounts.map(accountOf) }, 201);
});

accountRoutes.get("/account-transfers", view, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const rows = await db.execute(sql`
    select t.*, fa.name as from_name, ta.name as to_name, count(*) over () as total
    from account_transfers t left join accounts fa on fa.id = t.from_account_id join accounts ta on ta.id = t.to_account_id
    where t.business_id = ${businessId} order by t.transfer_date desc, t.number desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => ({
      id: String(row.id), number: String(row.number), transferDate: day(row.transfer_date), amountPaisa: paisa(row.amount_paisa), memo: String(row.memo),
      from: row.from_name ? String(row.from_name) : "Register", to: String(row.to_name),
    })),
    page, pageSize, total: rows.length ? paisa(rows[0].total) : 0,
  });
});

