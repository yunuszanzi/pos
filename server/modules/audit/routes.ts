import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { Hono } from "hono";
import { auditLog } from "../../../db/schema";
import { db } from "../../lib/db";
import { apiError } from "../../lib/http";
import { getPrincipal, requirePermission } from "../../lib/permissions";

export const auditRoutes = new Hono();

auditRoutes.get("/audit-log", requirePermission("audit.view"), async (context) => {
  const principal = getPrincipal(context);
  const page = Math.max(1, Number(context.req.query("page") ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(context.req.query("pageSize") ?? 25)));
  if (!Number.isInteger(page) || !Number.isInteger(pageSize)) return apiError(context, 400, "INVALID_PAGINATION", "Page values must be whole numbers");
  const filters = [eq(auditLog.businessId, principal.businessId!)];
  const from = context.req.query("from");
  const to = context.req.query("to");
  if (from && Number.isNaN(Date.parse(from))) return apiError(context, 400, "INVALID_DATE", "The from date is invalid");
  if (to && Number.isNaN(Date.parse(to))) return apiError(context, 400, "INVALID_DATE", "The to date is invalid");
  if (from) filters.push(gte(auditLog.createdAt, new Date(from)));
  if (to) filters.push(lte(auditLog.createdAt, new Date(to)));
  const data = await db.select().from(auditLog).where(and(...filters))
    .orderBy(desc(auditLog.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  const [{ total }] = await db.select({ total: count() }).from(auditLog).where(and(...filters));
  return context.json({ data, page, pageSize, total });
});
