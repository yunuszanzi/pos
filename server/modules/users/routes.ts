import { validateJson } from "../../lib/validate";
import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { Hono } from "hono";
import { appUsers, branches, permissions, rolePermissions, roles, userBranches } from "../../../db/schema";
import { roleSchema, userCreateSchema, userUpdateSchema } from "./schema";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { apiError, roleAboveActor } from "../../lib/http";
import { canManageRole, createdByActor, getPrincipal, holdsAllPermissions, requirePermission, updatedByActor } from "../../lib/permissions";
import { hashPin } from "../auth/pin";
import { supabaseAdmin } from "../../lib/supabaseAdmin";

export const usersRoutes = new Hono();

usersRoutes.get("/permissions", requirePermission("roles.view"), async (context) => {
  const rows = await db.select().from(permissions);
  return context.json(rows);
});

usersRoutes.get("/users", requirePermission("users.view"), async (context) => {
  const principal = getPrincipal(context);
  const page = Math.max(1, Number(context.req.query("page") ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(context.req.query("pageSize") ?? 25)));
  if (!Number.isInteger(page) || !Number.isInteger(pageSize)) return apiError(context, 400, "INVALID_PAGINATION", "Page values must be whole numbers");
  const search = context.req.query("q");
  const conditions = search
    ? and(eq(appUsers.businessId, principal.businessId!), or(ilike(appUsers.email, `%${search}%`), ilike(appUsers.displayName, `%${search}%`)))
    : eq(appUsers.businessId, principal.businessId!);
  const rows = await db.select({
    id: appUsers.id,
    email: appUsers.email,
    displayName: appUsers.displayName,
    roleId: appUsers.roleId,
    active: appUsers.active,
    createdAt: appUsers.createdAt,
  }).from(appUsers).where(conditions).orderBy(desc(appUsers.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  const [{ total }] = await db.select({ total: count() }).from(appUsers).where(conditions);
  return context.json({ data: rows, page, pageSize, total });
});

usersRoutes.post("/users", requirePermission("users.manage"), validateJson(userCreateSchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  const [role] = await db.select().from(roles).where(and(eq(roles.id, input.roleId), eq(roles.businessId, principal.businessId!))).limit(1);
  if (!role || role.name === "Owner") return apiError(context, 400, "INVALID_ROLE", "Choose an assignable role in this business");
  if (!await canManageRole(principal, role.id)) return roleAboveActor(context);
  const assignedBranches = await db.select({ id: branches.id }).from(branches)
    .where(and(eq(branches.businessId, principal.businessId!), inArray(branches.id, input.branchIds)));
  if (assignedBranches.length !== new Set(input.branchIds).size) {
    return apiError(context, 400, "INVALID_BRANCH", "One or more branches are not part of this business");
  }
  const { data: invited, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(input.email);
  if (inviteError || !invited.user) {
    return apiError(context, 400, "AUTH_INVITE_FAILED", "Could not invite this user. Check the email and try again.");
  }

  try {
    const [newUser] = await db.transaction(async (tx) => {
      const [created] = await tx.insert(appUsers).values({
        id: invited.user.id,
        businessId: principal.businessId!,
        roleId: role.id,
        email: input.email,
        displayName: input.displayName,
        pinHash: input.pin ? await hashPin(input.pin) : null,
        ...createdByActor(principal),
      }).returning();
      await tx.insert(userBranches).values(input.branchIds.map((branchId) => ({ userId: created.id, branchId })));
      return [created];
    });
    await auditPrincipal(context, principal, "user", newUser.id, "create", null, {
      email: newUser.email, displayName: newUser.displayName, roleId: newUser.roleId, active: newUser.active,
    });
    return context.json({
      id: newUser.id,
      email: newUser.email,
      displayName: newUser.displayName,
      roleId: newUser.roleId,
      active: newUser.active,
    }, 201);
  } catch (error) {
    const { error: cleanupError } = await supabaseAdmin.auth.admin.deleteUser(invited.user.id);
    if (cleanupError) {
      console.error("Failed to remove invited auth account after profile creation failed", cleanupError.message);
    }
    console.error("Failed to create invited user profile", error);
    return apiError(context, 500, "USER_CREATE_FAILED", "The invite was created but the user profile could not be saved");
  }
});

usersRoutes.put("/users/:id", requirePermission("users.manage"), validateJson(userUpdateSchema), async (context) => {
  const principal = getPrincipal(context);
  const id = context.req.param("id");
  if (!id) return apiError(context, 400, "INVALID_USER_ID", "User ID is required");
  if (id === principal.activeUserId && context.req.valid("json").active === false) {
    return apiError(context, 400, "CANNOT_DEACTIVATE_SELF", "You cannot deactivate your own account");
  }
  const [before] = await db.select().from(appUsers)
    .where(and(eq(appUsers.id, id), eq(appUsers.businessId, principal.businessId!))).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "User not found");
  if (before.id === principal.activeUserId && context.req.valid("json").roleId && context.req.valid("json").roleId !== before.roleId) {
    return apiError(context, 400, "CANNOT_CHANGE_OWN_ROLE", "You cannot change your own role");
  }
  if (!await canManageRole(principal, before.roleId)) return roleAboveActor(context);

  const input = context.req.valid("json");
  if (input.roleId) {
    const [role] = await db.select().from(roles)
      .where(and(eq(roles.id, input.roleId), eq(roles.businessId, principal.businessId!))).limit(1);
    if (!role || role.name === "Owner") return apiError(context, 400, "INVALID_ROLE", "Choose an assignable role in this business");
    if (!await canManageRole(principal, role.id)) return roleAboveActor(context);
  }
  if (input.branchIds) {
    const validBranches = await db.select({ id: branches.id }).from(branches)
      .where(and(eq(branches.businessId, principal.businessId!), inArray(branches.id, input.branchIds)));
    if (validBranches.length !== new Set(input.branchIds).size) {
      return apiError(context, 400, "INVALID_BRANCH", "One or more branches are not part of this business");
    }
  }
  const { pin, branchIds, ...profileChanges } = input;
  const [after] = await db.transaction(async (tx) => {
    const [updated] = await tx.update(appUsers).set({
      ...profileChanges,
      ...(pin ? { pinHash: await hashPin(pin) } : {}),
      ...updatedByActor(principal),
    }).where(eq(appUsers.id, id)).returning();
    if (branchIds) {
      await tx.delete(userBranches).where(eq(userBranches.userId, id));
      await tx.insert(userBranches).values(branchIds.map((branchId) => ({ userId: id, branchId })));
    }
    return [updated];
  });
  await auditPrincipal(context, principal, "user", id, "update", {
    displayName: before.displayName, roleId: before.roleId, active: before.active,
  }, {
    displayName: after.displayName, roleId: after.roleId, active: after.active,
  });
  return context.json({
    id: after.id,
    email: after.email,
    displayName: after.displayName,
    roleId: after.roleId,
    active: after.active,
  });
});

usersRoutes.post("/users/:id/password-reset", requirePermission("users.manage"), async (context) => {
  const principal = getPrincipal(context);
  const id = context.req.param("id");
  if (!id) return apiError(context, 400, "INVALID_USER_ID", "User ID is required");
  const [user] = await db.select().from(appUsers)
    .where(and(eq(appUsers.id, id), eq(appUsers.businessId, principal.businessId!))).limit(1);
  if (!user || !user.active) return apiError(context, 404, "NOT_FOUND", "Active user not found");
  if (!await canManageRole(principal, user.roleId)) return roleAboveActor(context);
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: "recovery", email: user.email });
  if (error || !data.properties?.action_link) {
    console.error("Failed to create user recovery link", error?.message);
    return apiError(context, 502, "PASSWORD_RESET_FAILED", "Could not create a password reset link");
  }
  await auditPrincipal(context, principal, "user", user.id, "password_reset_requested", null, { email: user.email });
  return context.json({ recoveryLink: data.properties.action_link });
});

usersRoutes.get("/roles", requirePermission("roles.view"), async (context) => {
  const principal = getPrincipal(context);
  const rows = await db.select().from(roles).where(eq(roles.businessId, principal.businessId!));
  const permissionRows = await db.select({
    roleId: rolePermissions.roleId,
    permissionKey: rolePermissions.permissionKey,
  }).from(rolePermissions)
    .innerJoin(roles, eq(rolePermissions.roleId, roles.id))
    .where(eq(roles.businessId, principal.businessId!));
  const byRole = new Map<string, string[]>();
  for (const row of permissionRows) {
    const keys = byRole.get(row.roleId) ?? [];
    keys.push(row.permissionKey);
    byRole.set(row.roleId, keys);
  }
  return context.json(rows.map((role) => ({ ...role, permissionKeys: byRole.get(role.id) ?? [] })));
});

usersRoutes.post("/roles", requirePermission("roles.manage"), validateJson(roleSchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  if (input.permissionKeys.includes("*")) return apiError(context, 400, "INVALID_PERMISSION", "The wildcard permission is reserved for the Owner role");
  if (!holdsAllPermissions(principal, input.permissionKeys)) return roleAboveActor(context);
  const valid = await db.select({ key: permissions.key }).from(permissions)
    .where(inArray(permissions.key, input.permissionKeys));
  if (valid.length !== new Set(input.permissionKeys).size) return apiError(context, 400, "INVALID_PERMISSION", "One or more permission keys are invalid");
  const [role] = await db.transaction(async (tx) => {
    const [created] = await tx.insert(roles).values({ businessId: principal.businessId!, name: input.name, ...createdByActor(principal) }).returning();
    if (input.permissionKeys.length) {
      await tx.insert(rolePermissions).values(input.permissionKeys.map((permissionKey) => ({ roleId: created.id, permissionKey })));
    }
    return [created];
  });
  await auditPrincipal(context, principal, "role", role.id, "create", null, { name: role.name, permissionKeys: input.permissionKeys });
  return context.json({ ...role, permissionKeys: input.permissionKeys }, 201);
});

usersRoutes.put("/roles/:id", requirePermission("roles.manage"), validateJson(roleSchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  const id = context.req.param("id");
  if (input.permissionKeys.includes("*")) return apiError(context, 400, "INVALID_PERMISSION", "The wildcard permission is reserved for the Owner role");
  const [before] = await db.select().from(roles)
    .where(and(eq(roles.id, id), eq(roles.businessId, principal.businessId!))).limit(1);
  if (!before || before.isSystem) return apiError(context, 404, "NOT_FOUND", "Editable role not found");
  if (!holdsAllPermissions(principal, input.permissionKeys) || !await canManageRole(principal, id)) return roleAboveActor(context);
  const valid = await db.select({ key: permissions.key }).from(permissions)
    .where(inArray(permissions.key, input.permissionKeys));
  if (valid.length !== new Set(input.permissionKeys).size) return apiError(context, 400, "INVALID_PERMISSION", "One or more permission keys are invalid");
  await db.transaction(async (tx) => {
    await tx.update(roles).set({ name: input.name, ...updatedByActor(principal) }).where(eq(roles.id, id));
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
    if (input.permissionKeys.length) {
      await tx.insert(rolePermissions).values(input.permissionKeys.map((permissionKey) => ({ roleId: id, permissionKey })));
    }
  });
  await auditPrincipal(context, principal, "role", id, "update", { name: before.name }, {
    name: input.name, permissionKeys: input.permissionKeys,
  });
  return context.json({ id, name: input.name, isSystem: before.isSystem, permissionKeys: input.permissionKeys });
});
