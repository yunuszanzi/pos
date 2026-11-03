import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { rolePermissions, appUsers } from "../../db/schema";
import { db } from "./db";

export type Principal = {
  authUserId: string;
  authEmail: string | null;
  userId: string | null;
  businessId: string | null;
  roleId: string | null;
  activeUserId: string | null;
  activeUserName: string | null;
  activeUserEmail: string | null;
  terminalId: string | null;
  permissions: Set<string>;
};

export const principalKey = "principal";

export function getPrincipal(context: Context): Principal {
  const principal = context.get(principalKey) as Principal | undefined;
  if (!principal) {
    throw new Error("Authenticated principal is missing");
  }
  return principal;
}

export async function getRolePermissions(roleId: string): Promise<Set<string>> {
  const rows = await db.select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));
  return new Set(rows.map((row) => row.key));
}

export async function requireBusinessUser(authUserId: string) {
  const [user] = await db.select()
    .from(appUsers)
    .where(and(eq(appUsers.id, authUserId), eq(appUsers.active, true)))
    .limit(1);
  return user ?? null;
}

export function hasPermission(principal: Principal, permission: string): boolean {
  return principal.permissions.has("*") || principal.permissions.has(permission);
}

/** Nobody may grant, or manage a user holding, a permission they do not hold themselves. */
export function holdsAllPermissions(principal: Principal, keys: Iterable<string>): boolean {
  if (principal.permissions.has("*")) return true;
  for (const key of keys) {
    if (!principal.permissions.has(key)) return false;
  }
  return true;
}

export async function canManageRole(principal: Principal, roleId: string): Promise<boolean> {
  return holdsAllPermissions(principal, await getRolePermissions(roleId));
}

export function requirePermission(permission: string) {
  return async (context: Context, next: () => Promise<void>) => {
    const principal = getPrincipal(context);
    if (!principal.businessId || !principal.activeUserId || !hasPermission(principal, permission)) {
      return context.json({ error: { code: "PERMISSION_DENIED", message: "You do not have permission to perform this action" } }, 403);
    }
    await next();
  };
}
