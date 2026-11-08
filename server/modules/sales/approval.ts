import { and, eq, ilike, inArray } from "drizzle-orm";
import { appUsers, rolePermissions, userBranches } from "../../../db/schema";
import { createPinRateKey } from "../../lib/auth";
import { db } from "../../lib/db";
import { verifyPin } from "../auth/pin";
import { clearPinAttempts, registerPinAttempt } from "../auth/pinRateLimit";

/** A manager's email and PIN, checked the same way as /auth/manager-override. Returns the manager's id. */
export async function approveByManager(businessId: string, terminalBranchId: string, email: string, pin: string, permission: string) {
  const rateKey = createPinRateKey(`override|${email.toLowerCase()}`);
  if (!(await registerPinAttempt(rateKey)).allowed) return "rate-limited" as const;
  const [manager] = await db.select().from(appUsers)
    .where(and(eq(appUsers.businessId, businessId), ilike(appUsers.email, email), eq(appUsers.active, true))).limit(1);
  if (!manager || !await verifyPin(pin, manager.pinHash)) return "invalid" as const;
  const [branchGrant] = await db.select().from(userBranches)
    .where(and(eq(userBranches.userId, manager.id), eq(userBranches.branchId, terminalBranchId))).limit(1);
  const [grant] = await db.select().from(rolePermissions)
    .where(and(eq(rolePermissions.roleId, manager.roleId), inArray(rolePermissions.permissionKey, [permission, "*"]))).limit(1);
  await clearPinAttempts(rateKey);
  return branchGrant && grant ? manager.id : "not-allowed" as const;
}
