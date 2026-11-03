import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { businessSettings } from "../../../db/schema";
import { settingsSchema } from "./schema";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { apiError } from "../../lib/http";
import { getPrincipal, requirePermission } from "../../lib/permissions";

export const settingsRoutes = new Hono();

settingsRoutes.get("/settings", requirePermission("settings.view"), async (context) => {
  const principal = getPrincipal(context);
  const [settings] = await db.select().from(businessSettings)
    .where(eq(businessSettings.businessId, principal.businessId!)).limit(1);
  if (!settings) return apiError(context, 404, "NOT_FOUND", "Settings not found");
  return context.json(settings);
});

settingsRoutes.put("/settings", requirePermission("settings.manage"), zValidator("json", settingsSchema), async (context) => {
  const principal = getPrincipal(context);
  const [before] = await db.select().from(businessSettings)
    .where(eq(businessSettings.businessId, principal.businessId!)).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Settings not found");
  const [after] = await db.update(businessSettings)
    .set({ ...context.req.valid("json"), updatedAt: new Date() })
    .where(eq(businessSettings.businessId, principal.businessId!))
    .returning();
  await auditPrincipal(context, principal, "settings", principal.businessId!, "update", before, after);
  return context.json(after);
});
