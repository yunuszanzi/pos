import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { fbrStatuses } from "../../../shared/fbr";
import { resubmit } from "../../fbr/service";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getPrincipal, requirePermission } from "../../lib/permissions";
import { escapeLike } from "../products/service";

// The FBR log (FR-FBR-15): every document that had to be reported, where it stands, and every request and answer, with a way to send it again.

export const fbrLogRoutes = new Hono();

const view = requirePermission("fbr.view");
const resubmitPermission = requirePermission("fbr.resubmit");
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const dayQuery = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined);

const submissionOf = (row: Record<string, unknown>) => ({
  id: String(row.id), docType: String(row.doc_type), docId: String(row.doc_id), number: String(row.number), status: String(row.status), environment: String(row.environment),
  attempts: Number(row.attempts), irn: row.irn ? String(row.irn) : null, errorCode: row.error_code ? String(row.error_code) : null, errorMessage: row.error_message ? String(row.error_message) : null,
  nextRetryAt: iso(row.next_retry_at), lastAttemptAt: iso(row.last_attempt_at), createdAt: iso(row.created_at), acceptedAt: iso(row.accepted_at),
});

fbrLogRoutes.get("/fbr/submissions", view, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const status = context.req.query("status") ?? "";
  const docType = context.req.query("docType") ?? "";
  const from = dayQuery(context.req.query("from"));
  const to = dayQuery(context.req.query("to"));
  const search = context.req.query("q")?.trim().slice(0, 100);
  const page = Math.max(1, Math.trunc(Number(context.req.query("page") ?? 1)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(context.req.query("pageSize") ?? 25)) || 25));
  const filters = [sql`s.business_id = ${businessId}`];
  if ((fbrStatuses as readonly string[]).includes(status)) filters.push(sql`s.status = ${status}`);
  // "Needs attention" is what an owner should look at: refused by FBR, or given up.
  if (status === "attention") filters.push(sql`s.status in ('rejected', 'failed')`);
  if (docType === "sales_invoice" || docType === "sales_return") filters.push(sql`s.doc_type = ${docType}`);
  if (from) filters.push(sql`s.created_at >= (${from}::date)::timestamp at time zone 'Asia/Karachi'`);
  if (to) filters.push(sql`s.created_at < (${to}::date + 1)::timestamp at time zone 'Asia/Karachi'`);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    filters.push(sql`(s.number ilike ${pattern} or s.irn ilike ${pattern})`);
  }
  const rows = await db.execute(sql`
    select s.*, count(*) over () as total from fbr_submissions s where ${sql.join(filters, sql` and `)}
    order by s.created_at desc, s.id limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({ data: rows.map(submissionOf), page, pageSize, total: rows.length ? Number(rows[0].total) : 0 });
});

/** How many are waiting, refused or given up: for the dashboard and the menu. */
fbrLogRoutes.get("/fbr/summary", view, async (context) => {
  const [row] = await db.execute(sql`
    select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'rejected')::int as rejected,
           count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'accepted')::int as accepted
    from fbr_submissions where business_id = ${getPrincipal(context).businessId!}`);
  return context.json({ pending: Number(row.pending), rejected: Number(row.rejected), failed: Number(row.failed), accepted: Number(row.accepted) });
});

fbrLogRoutes.get("/fbr/submissions/:id", view, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const [row] = await db.execute(sql`select * from fbr_submissions where id = ${paramId(context)} and business_id = ${businessId}`);
  if (!row) return apiError(context, 404, "NOT_FOUND", "Submission not found");
  const attempts = await db.execute(sql`select * from fbr_attempts where submission_id = ${row.id as string} order by created_at, id`);
  return context.json({
    ...submissionOf(row), refIrn: row.ref_irn ? String(row.ref_irn) : null, payload: row.payload ?? null, response: row.response ?? null,
    attempts: attempts.map((attempt) => ({
      id: String(attempt.id), attemptNo: Number(attempt.attempt_no), step: String(attempt.step), outcome: String(attempt.outcome), httpStatus: attempt.http_status === null ? null : Number(attempt.http_status),
      message: String(attempt.message), request: attempt.request ?? null, response: attempt.response ?? null, createdAt: iso(attempt.created_at),
    })),
  });
});

/** Send it again, after fixing whatever FBR or the checks complained about. An accepted invoice is never sent twice. */
fbrLogRoutes.post("/fbr/submissions/:id/retry", resubmitPermission, idempotent(), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const result = await resubmit(principal.businessId!, id);
  if ("error" in result) return apiError(context, result.error === "NOT_FOUND" ? 404 : 409, result.error === "ACCEPTED" ? "ALREADY_ACCEPTED" : result.error, result.message);
  await auditPrincipal(context, principal, "fbr_submission", id, "resubmit", null, { status: result.outcome.status });
  return context.json(result.outcome);
});
