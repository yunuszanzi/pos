import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { resolveBranchId } from "../sales/location";

// Day-end closing (FR-CSH-07): a branch's day written down once, from its shifts and ledgers. See migration 0025.

export const dayClosingRoutes = new Hono();

const view = requirePermission("shifts.view_all");
const close = requirePermission("cash.close_day");
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);
const dayQuery = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined);
const todayKarachi = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());

const closeSchema = z.object({
  branchId: z.string().uuid().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Write the date as yyyy-mm-dd").optional(),
  note: z.string().trim().max(1000).default(""),
});
const reopenSchema = z.object({ reason: z.string().trim().min(1, "Say why the day is being reopened").max(300) });

const errors: Array<[prefix: string, status: 404 | 409 | 422, code: string]> = [
  ["NOT_FOUND", 404, "NOT_FOUND"],
  ["INVALID_BRANCH", 422, "INVALID_BRANCH"],
  ["INVALID_DATE", 422, "INVALID_DATE"],
  ["REASON_REQUIRED", 422, "REASON_REQUIRED"],
  ["DAY_CLOSED", 409, "DAY_CLOSED"],
  ["SHIFTS_OPEN", 409, "SHIFTS_OPEN"],
];

const closingOf = (row: Record<string, unknown>) => ({
  id: String(row.id), number: String(row.number), branchId: String(row.branch_id), branchName: String(row.branch_name), businessDate: day(row.business_date),
  closedAt: iso(row.closed_at), closedByName: row.closed_by_name ? String(row.closed_by_name) : null, note: String(row.note),
  reopened: Boolean(row.reopened_at), reopenedAt: iso(row.reopened_at), reopenedByName: row.reopened_by_name ? String(row.reopened_by_name) : null,
  reopenReason: row.reopen_reason ? String(row.reopen_reason) : null,
});

async function loadClosing(businessId: string, id: string) {
  const [row] = await db.execute(sql`
    select d.*, b.name as branch_name, u.display_name as closed_by_name, r.display_name as reopened_by_name
    from day_closings d join branches b on b.id = d.branch_id left join users u on u.id = d.closed_by left join users r on r.id = d.reopened_by
    where d.business_id = ${businessId} and d.id = ${id}`);
  return row ? { ...closingOf(row), summary: row.summary } : null;
}

/** What closing would write down, and what stands in the way, without closing. */
dayClosingRoutes.get("/day-closings/preview", view, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const date = dayQuery(context.req.query("date")) ?? todayKarachi();
  if (date > todayKarachi()) return apiError(context, 422, "INVALID_DATE", "A day cannot be closed before it has happened");
  const branchId = await resolveBranchId(businessId, context.req.query("branchId") || undefined, principal.terminalId);
  if (!branchId) return apiError(context, 422, "INVALID_BRANCH", "This branch is not available");
  const [summary] = await db.execute<{ summary: unknown }>(sql`select day_summary(${businessId}::uuid, ${branchId}::uuid, ${date}::date) as summary`);
  const [open] = await db.execute<{ names: string | null }>(sql`
    select string_agg(t.name, ', ' order by t.name) as names from shifts s join terminals t on t.id = s.terminal_id
    where s.business_id = ${businessId} and s.branch_id = ${branchId} and s.status = 'open' and (s.opened_at at time zone 'Asia/Karachi')::date <= ${date}::date`);
  const [existing] = await db.execute<{ id: string }>(sql`select id from day_closings where branch_id = ${branchId} and business_date = ${date}::date and reopened_at is null`);
  const [branch] = await db.execute<{ name: string }>(sql`select name from branches where id = ${branchId}`);
  return context.json({ branchId, branchName: branch.name, date, summary: summary.summary, openShifts: open.names, closingId: existing?.id ?? null });
});

dayClosingRoutes.get("/day-closings", view, async (context) => {
  const principal = getPrincipal(context);
  const page = Math.max(1, Math.trunc(Number(context.req.query("page") ?? 1)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(context.req.query("pageSize") ?? 25)) || 25));
  const branchId = context.req.query("branchId");
  const rows = await db.execute(sql`
    select d.*, b.name as branch_name, u.display_name as closed_by_name, r.display_name as reopened_by_name, count(*) over () as total
    from day_closings d join branches b on b.id = d.branch_id left join users u on u.id = d.closed_by left join users r on r.id = d.reopened_by
    where d.business_id = ${principal.businessId!} ${branchId && /^[0-9a-f-]{36}$/i.test(branchId) ? sql`and d.branch_id = ${branchId}` : sql``}
    order by d.business_date desc, d.closed_at desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => {
      const summary = row.summary as { sales?: { totalPaisa?: number; bills?: number }; cashVariancePaisa?: number };
      return { ...closingOf(row), salesPaisa: Number(summary.sales?.totalPaisa ?? 0), bills: Number(summary.sales?.bills ?? 0), cashVariancePaisa: Number(summary.cashVariancePaisa ?? 0) };
    }),
    page, pageSize, total: rows.length ? Number(rows[0].total) : 0,
  });
});

dayClosingRoutes.get("/day-closings/:id", view, async (context) => {
  const found = await loadClosing(getPrincipal(context).businessId!, paramId(context));
  return found ? context.json(found) : apiError(context, 404, "NOT_FOUND", "Day closing not found");
});

dayClosingRoutes.post("/day-closings", close, idempotent(), validateJson(closeSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  const branchId = await resolveBranchId(businessId, input.branchId, principal.terminalId);
  if (!branchId) return apiError(context, 422, "INVALID_BRANCH", "This branch is not available");
  const date = input.date ?? todayKarachi();
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select post_day_closing(${JSON.stringify({ business_id: businessId, branch_id: branchId, business_date: date, note: input.note })}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const message = dbErrorMessage(error);
    const known = errors.find(([prefix]) => message.includes(prefix));
    if (known) return apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message);
    throw error;
  }
  await auditPrincipal(context, principal, "day_closing", id, "close", null, { date, branchId });
  return context.json(await loadClosing(businessId, id), 201);
});

dayClosingRoutes.post("/day-closings/:id/reopen", close, idempotent(), validateJson(reopenSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  const { reason } = context.req.valid("json");
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select reopen_day_closing(${businessId}::uuid, ${id}::uuid, ${reason}, ${getActorId(principal)})`);
    });
  } catch (error) {
    const message = dbErrorMessage(error);
    const known = errors.find(([prefix]) => message.includes(prefix));
    if (known) return apiError(context, known[1], known[2], message.replace(/^[A-Z_]+:?\s*/, "") || message);
    throw error;
  }
  await auditPrincipal(context, principal, "day_closing", id, "reopen", null, { reason });
  return context.json(await loadClosing(businessId, id));
});
