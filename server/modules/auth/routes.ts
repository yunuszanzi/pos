import { zValidator } from "@hono/zod-validator";
import { and, eq, ilike, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { appUsers, auditLog, rolePermissions, terminals, userBranches } from "../../../db/schema";
import { managerOverrideSchema, pinSwitchSchema } from "../../../shared/schemas/auth";
import { auditPrincipal } from "../../lib/audit";
import { createPinRateKey, createPinSession } from "../../lib/auth";
import { db } from "../../lib/db";
import { apiError } from "../../lib/http";
import { getPrincipal, requirePermission } from "../../lib/permissions";
import { verifyPin } from "./pin";
import { clearPinAttempts, registerPinAttempt } from "./pinRateLimit";

export const authRoutes = new Hono();

authRoutes.get("/me", async (context) => {
  const principal = getPrincipal(context);
  return context.json({
    authUserId: principal.authUserId,
    email: principal.authEmail,
    userId: principal.userId,
    activeUserId: principal.activeUserId,
    activeUserName: principal.activeUserName,
    activeUserEmail: principal.activeUserEmail,
    businessId: principal.businessId,
    roleId: principal.roleId,
    terminalId: principal.terminalId,
    permissions: [...principal.permissions],
  });
});

authRoutes.post("/auth/login-event", async (context) => {
  const principal = getPrincipal(context);
  if (!principal.userId || !principal.businessId) {
    return apiError(context, 409, "BUSINESS_SETUP_REQUIRED", "Complete business setup before recording a login");
  }
  await db.update(appUsers).set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(appUsers.id, principal.userId));
  await auditPrincipal(context, principal, "user", principal.userId, "login", null, {
    email: principal.authEmail,
  });
  return context.json({ recorded: true });
});

authRoutes.post("/auth/pin-switch", requirePermission("auth.pin_switch"), zValidator("json", pinSwitchSchema), async (context) => {
  const principal = getPrincipal(context);
  const { targetEmail, pin, terminalId } = context.req.valid("json");
  if (context.req.header("X-Terminal-Id") !== terminalId) {
    return apiError(context, 400, "TERMINAL_MISMATCH", "Select the terminal before switching users");
  }
  const [terminal] = await db.select().from(terminals)
    .where(and(eq(terminals.id, terminalId), eq(terminals.businessId, principal.businessId!), eq(terminals.active, true)))
    .limit(1);
  if (!terminal) return apiError(context, 404, "TERMINAL_NOT_FOUND", "Terminal not found");
  const rateKey = createPinRateKey(`switch|${targetEmail.toLowerCase()}`);
  const attempt = await registerPinAttempt(rateKey);
  if (!attempt.allowed) return apiError(context, 429, "RATE_LIMITED", "Too many PIN attempts. Wait 15 minutes and try again.");

  const [target] = await db.select().from(appUsers)
    .where(and(eq(appUsers.businessId, principal.businessId!), ilike(appUsers.email, targetEmail), eq(appUsers.active, true)))
    .limit(1);
  if (!target || !await verifyPin(pin, target.pinHash)) {
    return apiError(context, 401, "INVALID_PIN", "Email or PIN is incorrect");
  }
  await clearPinAttempts(rateKey);
  const [branchGrant] = await db.select().from(userBranches)
    .where(and(eq(userBranches.userId, target.id), eq(userBranches.branchId, terminal.branchId))).limit(1);
  if (!branchGrant) return apiError(context, 403, "BRANCH_ACCESS_DENIED", "This user is not assigned to the terminal branch");

  await auditPrincipal(context, principal, "user", principal.activeUserId ?? principal.authUserId, "pin_switch_out", null, { switchedToUserId: target.id, terminalId });
  await db.insert(auditLog).values({
    businessId: principal.businessId!,
    entity: "user",
    entityId: target.id,
    action: "pin_switch_in",
    before: { switchedFromUserId: principal.activeUserId },
    after: { terminalId },
    userId: target.id,
    terminalId,
  });

  const pinSession = createPinSession({
    baseUserId: principal.authUserId,
    activeUserId: target.id,
    businessId: target.businessId,
    terminalId,
  });
  return context.json({
    pinSession,
    activeUser: { id: target.id, email: target.email, displayName: target.displayName },
  });
});

authRoutes.post("/auth/manager-override", zValidator("json", managerOverrideSchema), async (context) => {
  const principal = getPrincipal(context);
  if (!principal.businessId || !principal.activeUserId) {
    return apiError(context, 403, "PERMISSION_DENIED", "A business user is required for this action");
  }
  const { managerEmail, pin, permission } = context.req.valid("json");
  const rateKey = createPinRateKey(`override|${managerEmail.toLowerCase()}`);
  const attempt = await registerPinAttempt(rateKey);
  if (!attempt.allowed) return apiError(context, 429, "RATE_LIMITED", "Too many PIN attempts. Wait 15 minutes and try again.");
  const [manager] = await db.select().from(appUsers)
    .where(and(eq(appUsers.businessId, principal.businessId!), ilike(appUsers.email, managerEmail), eq(appUsers.active, true)))
    .limit(1);
  if (!manager || !await verifyPin(pin, manager.pinHash)) {
    return apiError(context, 401, "INVALID_PIN", "Manager email or PIN is incorrect");
  }
  const terminalId = context.req.header("X-Terminal-Id");
  if (terminalId) {
    const [terminal] = await db.select().from(terminals)
      .where(and(eq(terminals.id, terminalId), eq(terminals.businessId, principal.businessId!), eq(terminals.active, true)))
      .limit(1);
    if (!terminal) return apiError(context, 403, "OVERRIDE_NOT_ALLOWED", "This manager cannot approve actions at the selected terminal");
    const [branchGrant] = await db.select().from(userBranches)
      .where(and(eq(userBranches.userId, manager.id), eq(userBranches.branchId, terminal.branchId))).limit(1);
    if (!branchGrant) return apiError(context, 403, "OVERRIDE_NOT_ALLOWED", "This manager is not assigned to the terminal branch");
  }
  const grant = await db.select().from(rolePermissions)
    .where(and(eq(rolePermissions.roleId, manager.roleId), inArray(rolePermissions.permissionKey, [permission, "*"]))).limit(1);
  if (!await verifyPin(pin, manager.pinHash)) return apiError(context, 401, "INVALID_PIN", "Manager email or PIN is incorrect");
  await clearPinAttempts(rateKey);
  if (!grant.length) return apiError(context, 403, "OVERRIDE_NOT_ALLOWED", "This manager cannot approve the requested action");
  await auditPrincipal(context, principal, "permission", permission, "manager_override", null, { approvedByUserId: manager.id });
  return context.json({ approved: true, approvedByUserId: manager.id });
});
