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

// Sales rung up offline that need a look: stock that went below zero, a price or tax that changed meanwhile, a discount above the
// cashier's limit that no manager could approve with the connection down. They are already posted; reviewing records that a person
// with authority has seen them. The sale itself never changes.

export const offlineSaleRoutes = new Hono();

const review = requirePermission("sales.offline_review");
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

export const offlineFlagLabels: Record<string, string> = {
  NEGATIVE_STOCK: "Stock went below zero",
  PRICE_CHANGED: "A price or tax changed while offline",
  DISCOUNT_OVER_LIMIT: "Discount above the cashier's limit, not approved",
};

offlineSaleRoutes.get("/offline-sales", review, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const status = context.req.query("status") === "reviewed" ? "reviewed" : "open";
  const page = Math.max(1, Math.trunc(Number(context.req.query("page") ?? 1)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(context.req.query("pageSize") ?? 25)) || 25));
  const rows = await db.execute(sql`
    select f.invoice_id, f.flags, f.detail, f.created_at, f.reviewed_at, f.review_note, i.number, i.offline_ref, i.posted_at, i.total_paisa,
           u.display_name as cashier_name, r.display_name as reviewed_by_name, count(*) over () as total
    from offline_sale_flags f join sales_invoices i on i.id = f.invoice_id left join users u on u.id = i.cashier_id left join users r on r.id = f.reviewed_by
    where f.business_id = ${businessId} and ${status === "open" ? sql`f.reviewed_at is null` : sql`f.reviewed_at is not null`}
    order by f.created_at desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({
    data: rows.map((row) => ({
      invoiceId: String(row.invoice_id), number: String(row.number), offlineRef: row.offline_ref ? String(row.offline_ref) : null, soldAt: iso(row.posted_at), syncedAt: iso(row.created_at),
      totalPaisa: Number(row.total_paisa), cashierName: row.cashier_name ? String(row.cashier_name) : null,
      flags: (row.flags as string[]).map((flag) => ({ code: flag, label: offlineFlagLabels[flag] ?? flag })), detail: row.detail ?? {},
      reviewedAt: iso(row.reviewed_at), reviewedByName: row.reviewed_by_name ? String(row.reviewed_by_name) : null, reviewNote: String(row.review_note ?? ""),
    })),
    page, pageSize, total: rows.length ? Number(rows[0].total) : 0,
  });
});

/** How many are waiting for a look, for the dashboard and the menu. */
offlineSaleRoutes.get("/offline-sales/summary", review, async (context) => {
  const [row] = await db.execute(sql`select count(*)::int as open from offline_sale_flags where business_id = ${getPrincipal(context).businessId!} and reviewed_at is null`);
  return context.json({ open: Number(row.open) });
});

offlineSaleRoutes.post("/offline-sales/:id/review", review, idempotent(), validateJson(z.object({ note: z.string().trim().max(500).default("") })), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select review_offline_sale(${principal.businessId!}::uuid, ${id}::uuid, ${context.req.valid("json").note}, ${getActorId(principal)})`);
    });
  } catch (error) {
    if (dbErrorMessage(error).includes("NOT_FOUND")) return apiError(context, 404, "NOT_FOUND", "There is nothing to review on that sale");
    throw error;
  }
  await auditPrincipal(context, principal, "sales_invoice", id, "offline_review", null, { note: context.req.valid("json").note });
  return context.json({ ok: true });
});
