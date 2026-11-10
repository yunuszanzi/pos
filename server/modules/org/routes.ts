import { validateJson } from "../../lib/validate";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { auditLog, businessSettings, businesses, branches, documentSeries, locations, permissions, rolePermissions, roles, terminals, userBranches, appUsers } from "../../../db/schema";
import { cashierPermissionKeys, managerPermissionKeys, permissionDefinitions } from "../../../shared/permissions";
import { branchSchema, businessUpdateSchema, documentSeriesSchema, locationSchema, setupBusinessSchema, terminalSchema } from "./schema";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { conflictOrThrow } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { createdByActor, getPrincipal, requirePermission, updatedByActor } from "../../lib/permissions";
import { hashPin } from "../auth/pin";

export const orgRoutes = new Hono();

orgRoutes.post("/org/setup", validateJson(setupBusinessSchema), async (context) => {
  const principal = getPrincipal(context);
  if (!principal.authEmail) return apiError(context, 400, "EMAIL_REQUIRED", "Your signed-in account needs an email address");
  const ownerEmail = principal.authEmail;
  const [existing] = await db.select({ id: appUsers.id }).from(appUsers).where(eq(appUsers.id, principal.authUserId)).limit(1);
  if (existing) return apiError(context, 409, "BUSINESS_ALREADY_CONFIGURED", "This account already belongs to a business");

  const input = context.req.valid("json");
  const authorship = createdByActor(principal);
  const result = await db.transaction(async (tx) => {
    const [business] = await tx.insert(businesses).values({
      legalName: input.legalName,
      tradeName: input.tradeName,
      phone: input.phone,
      address: input.address,
      ntn: input.ntn,
      strn: input.strn,
      province: input.province,
      logoUrl: input.logoUrl,
      receiptFooter: input.receiptFooter,
      ...authorship,
    }).returning();
    const [branch] = await tx.insert(branches).values({
      businessId: business.id,
      name: input.branchName,
      code: input.branchCode,
      ...authorship,
    }).returning();
    const [location] = await tx.insert(locations).values({
      businessId: business.id,
      branchId: branch.id,
      name: input.locationName,
      type: "store",
      ...authorship,
    }).returning();
    const [terminal] = await tx.insert(terminals).values({
      businessId: business.id,
      branchId: branch.id,
      name: input.terminalName,
      ...authorship,
    }).returning();
    await tx.insert(permissions).values(permissionDefinitions.map(([key, description]) => ({ key, description }))).onConflictDoNothing();
    const [ownerRole] = await tx.insert(roles).values({
      businessId: business.id,
      name: "Owner",
      isSystem: true,
      maxDiscountBps: 10000,
      ...authorship,
    }).returning();
    const [managerRole] = await tx.insert(roles).values({
      businessId: business.id,
      name: "Manager",
      isSystem: true,
      maxDiscountBps: 10000,
      ...authorship,
    }).returning();
    const [cashierRole] = await tx.insert(roles).values({
      businessId: business.id,
      name: "Cashier",
      isSystem: true,
      maxDiscountBps: 500,
      ...authorship,
    }).returning();
    const permissionRows = await tx.select({ key: permissions.key }).from(permissions);
    await tx.insert(rolePermissions).values(permissionRows.map(({ key }) => ({ roleId: ownerRole.id, permissionKey: key })));
    await tx.insert(rolePermissions).values(managerPermissionKeys.map((permissionKey) => ({ roleId: managerRole.id, permissionKey })));
    await tx.insert(rolePermissions).values(cashierPermissionKeys.map((permissionKey) => ({ roleId: cashierRole.id, permissionKey })));
    const [owner] = await tx.insert(appUsers).values({
      id: principal.authUserId,
      businessId: business.id,
      roleId: ownerRole.id,
      email: ownerEmail,
      displayName: ownerEmail.split("@")[0],
      pinHash: await hashPin(input.ownerPin),
      ...authorship,
    }).returning({ id: appUsers.id });
    await tx.insert(userBranches).values({ userId: owner.id, branchId: branch.id });
    await tx.insert(businessSettings).values({ businessId: business.id, ...authorship });
    await tx.execute(sql`SELECT seed_catalogue_defaults(${business.id}, ${authorship.createdBy})`);
    await tx.execute(sql`SELECT seed_sales_defaults(${business.id}, ${authorship.createdBy})`);
    await tx.insert(documentSeries).values({
      businessId: business.id,
      branchId: branch.id,
      docType: "invoice",
      prefix: input.documentPrefix,
      ...authorship,
    });
    await tx.insert(documentSeries).values({
      businessId: business.id,
      branchId: branch.id,
      docType: "return",
      prefix: `${input.documentPrefix}-R`,
      ...authorship,
    });
    await tx.insert(auditLog).values({
      businessId: business.id,
      entity: "business",
      entityId: business.id,
      action: "business_setup",
      after: { legalName: business.legalName, tradeName: business.tradeName },
      userId: owner.id,
      terminalId: terminal.id,
    });
    return { business, branch, location, terminal };
  });
  return context.json(result, 201);
});

orgRoutes.get("/business", requirePermission("business.view"), async (context) => {
  const principal = getPrincipal(context);
  const [business] = await db.select().from(businesses).where(eq(businesses.id, principal.businessId!)).limit(1);
  if (!business) return apiError(context, 404, "NOT_FOUND", "Business profile not found");
  return context.json(business);
});

orgRoutes.put("/business", requirePermission("business.update"), validateJson(businessUpdateSchema), async (context) => {
  const principal = getPrincipal(context);
  const values = context.req.valid("json");
  const [before] = await db.select().from(businesses).where(eq(businesses.id, principal.businessId!)).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Business profile not found");
  const [after] = await db.update(businesses).set({ ...values, ...updatedByActor(principal) })
    .where(eq(businesses.id, principal.businessId!)).returning();
  await auditPrincipal(context, principal, "business", after.id, "update", before, after);
  return context.json(after);
});

orgRoutes.get("/branches", requirePermission("branches.view"), async (context) => {
  const principal = getPrincipal(context);
  return context.json(await db.select().from(branches).where(eq(branches.businessId, principal.businessId!)));
});

orgRoutes.post("/branches", requirePermission("branches.manage"), validateJson(branchSchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  try {
    // Every branch needs an invoice series, or nothing could be sold there.
    const branch = await db.transaction(async (tx) => {
      const [created] = await tx.insert(branches).values({ ...input, businessId: principal.businessId!, ...createdByActor(principal) }).returning();
      await tx.insert(documentSeries).values({
        businessId: principal.businessId!, branchId: created.id, docType: "invoice", prefix: `INV-${input.code.toUpperCase()}`, ...createdByActor(principal),
      });
      return created;
    });
    await auditPrincipal(context, principal, "branch", branch.id, "create", null, branch);
    return context.json(branch, 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

orgRoutes.put("/branches/:id", requirePermission("branches.manage"), validateJson(branchSchema.partial()), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const [before] = await db.select().from(branches).where(and(eq(branches.id, id), eq(branches.businessId, principal.businessId!))).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Branch not found");
  const [after] = await db.update(branches).set({ ...context.req.valid("json"), ...updatedByActor(principal) })
    .where(eq(branches.id, id)).returning();
  await auditPrincipal(context, principal, "branch", id, "update", before, after);
  return context.json(after);
});

orgRoutes.get("/locations", requirePermission("locations.view"), async (context) => {
  const principal = getPrincipal(context);
  return context.json(await db.select().from(locations).where(eq(locations.businessId, principal.businessId!)));
});

orgRoutes.post("/locations", requirePermission("locations.manage"), validateJson(locationSchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  const [branch] = await db.select({ id: branches.id }).from(branches)
    .where(and(eq(branches.id, input.branchId), eq(branches.businessId, principal.businessId!))).limit(1);
  if (!branch) return apiError(context, 400, "INVALID_BRANCH", "Select a branch in this business");
  const [location] = await db.insert(locations).values({ ...input, businessId: principal.businessId!, ...createdByActor(principal) }).returning();
  await auditPrincipal(context, principal, "location", location.id, "create", null, location);
  return context.json(location, 201);
});

orgRoutes.put("/locations/:id", requirePermission("locations.manage"), validateJson(locationSchema.partial()), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const [before] = await db.select().from(locations).where(and(eq(locations.id, id), eq(locations.businessId, principal.businessId!))).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Location not found");
  const input = context.req.valid("json");
  if (input.branchId) {
    const [branch] = await db.select({ id: branches.id }).from(branches)
      .where(and(eq(branches.id, input.branchId), eq(branches.businessId, principal.businessId!))).limit(1);
    if (!branch) return apiError(context, 400, "INVALID_BRANCH", "Select a branch in this business");
  }
  const [after] = await db.update(locations).set({ ...input, ...updatedByActor(principal) })
    .where(eq(locations.id, id)).returning();
  await auditPrincipal(context, principal, "location", id, "update", before, after);
  return context.json(after);
});

orgRoutes.get("/terminals", requirePermission("terminals.view"), async (context) => {
  const principal = getPrincipal(context);
  return context.json(await db.select().from(terminals).where(eq(terminals.businessId, principal.businessId!)));
});

orgRoutes.post("/terminals", requirePermission("terminals.manage"), validateJson(terminalSchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  const [branch] = await db.select({ id: branches.id }).from(branches)
    .where(and(eq(branches.id, input.branchId), eq(branches.businessId, principal.businessId!))).limit(1);
  if (!branch) return apiError(context, 400, "INVALID_BRANCH", "Select a branch in this business");
  const [terminal] = await db.insert(terminals).values({ ...input, businessId: principal.businessId!, ...createdByActor(principal) }).returning();
  await auditPrincipal(context, principal, "terminal", terminal.id, "create", null, terminal);
  return context.json(terminal, 201);
});

orgRoutes.put("/terminals/:id", requirePermission("terminals.manage"), validateJson(terminalSchema.partial()), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const [before] = await db.select().from(terminals).where(and(eq(terminals.id, id), eq(terminals.businessId, principal.businessId!))).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Terminal not found");
  const input = context.req.valid("json");
  if (input.branchId) {
    const [branch] = await db.select({ id: branches.id }).from(branches)
      .where(and(eq(branches.id, input.branchId), eq(branches.businessId, principal.businessId!))).limit(1);
    if (!branch) return apiError(context, 400, "INVALID_BRANCH", "Select a branch in this business");
  }
  const [after] = await db.update(terminals).set({ ...input, ...updatedByActor(principal) })
    .where(eq(terminals.id, id)).returning();
  await auditPrincipal(context, principal, "terminal", id, "update", before, after);
  return context.json(after);
});

orgRoutes.get("/document-series", requirePermission("document_series.view"), async (context) => {
  const principal = getPrincipal(context);
  return context.json(await db.select().from(documentSeries).where(eq(documentSeries.businessId, principal.businessId!)));
});

orgRoutes.post("/document-series", requirePermission("document_series.manage"), validateJson(documentSeriesSchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  const [branch] = await db.select({ id: branches.id }).from(branches)
    .where(and(eq(branches.id, input.branchId), eq(branches.businessId, principal.businessId!))).limit(1);
  if (!branch) return apiError(context, 400, "INVALID_BRANCH", "Select a branch in this business");
  const [series] = await db.insert(documentSeries).values({ ...input, businessId: principal.businessId!, ...createdByActor(principal) }).returning();
  await auditPrincipal(context, principal, "document_series", series.id, "create", null, series);
  return context.json(series, 201);
});

orgRoutes.put("/document-series/:id", requirePermission("document_series.manage"), validateJson(documentSeriesSchema.partial()), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const [before] = await db.select().from(documentSeries)
    .where(and(eq(documentSeries.id, id), eq(documentSeries.businessId, principal.businessId!))).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Document series not found");
  const input = context.req.valid("json");
  if (input.branchId) {
    const [branch] = await db.select({ id: branches.id }).from(branches)
      .where(and(eq(branches.id, input.branchId), eq(branches.businessId, principal.businessId!))).limit(1);
    if (!branch) return apiError(context, 400, "INVALID_BRANCH", "Select a branch in this business");
  }
  const [after] = await db.update(documentSeries).set({ ...input, ...updatedByActor(principal) })
    .where(eq(documentSeries.id, id)).returning();
  await auditPrincipal(context, principal, "document_series", id, "update", before, after);
  return context.json(after);
});
