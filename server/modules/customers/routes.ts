import { and, asc, eq, gt, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { areas, customerGroups, customers, dataVersions, priceLists } from "../../../db/schema";
import { areaSchema, customerGroupSchema, customerSchema, quickCustomerSchema } from "../../../shared/schemas/customers";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { conflictOrThrow } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { createdByActor, getPrincipal, hasPermission, requirePermission, updatedByActor, type Principal } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { escapeLike } from "../products/service";

export const customersRoutes = new Hono();

const view = requirePermission("customers.view");
const create = requirePermission("customers.create");
const manage = requirePermission("customers.manage");

type Row = typeof customers.$inferSelect;

/** The CNIC is an identity number: only people who manage customers see it, and it never reaches a till's cache. */
const present = (row: Row, principal: Principal) => {
  const { cnic, changeVersion, balancePaisa, ...rest } = row;
  void changeVersion;
  // What a customer owes is for people who may see the khata.
  const visible = hasPermission(principal, "customers.ledger") ? { ...rest, balancePaisa } : rest;
  return hasPermission(principal, "customers.manage") ? { ...visible, cnic } : visible;
};

/** An audit entry records what changed, not the CNIC itself. The balance is the ledger's, not an edit. */
const forAudit = (row: Row) => {
  const { cnic, changeVersion, balancePaisa, ...rest } = row;
  void changeVersion;
  void balancePaisa;
  return { ...rest, cnicSet: Boolean(cnic) };
};

/** The group, area and price list must belong to this business. Returns a message when one does not. */
async function referenceProblem(businessId: string, input: { areaId: string | null; groupId: string | null; priceListId: string | null }): Promise<string | null> {
  const found = async (table: typeof areas | typeof customerGroups | typeof priceLists, id: string) =>
    (await db.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.businessId, businessId))).limit(1)).length > 0;
  if (input.areaId && !await found(areas, input.areaId)) return "Choose an area from this business";
  if (input.groupId && !await found(customerGroups, input.groupId)) return "Choose a group from this business";
  if (input.priceListId && !await found(priceLists, input.priceListId)) return "Choose a price list from this business";
  return null;
}

const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});
const uuidParam = (value: string | undefined) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined);

// ---------------------------------------------------------------- customers

customersRoutes.get("/customers", view, async (context) => {
  const principal = getPrincipal(context);
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const filters: SQL[] = [eq(customers.businessId, principal.businessId!)];
  const active = context.req.query("active") ?? "true";
  if (active !== "all") filters.push(eq(customers.active, active !== "false"));
  const areaId = uuidParam(context.req.query("areaId"));
  const groupId = uuidParam(context.req.query("groupId"));
  if (areaId) filters.push(eq(customers.areaId, areaId));
  if (groupId) filters.push(eq(customers.groupId, groupId));
  const search = context.req.query("q")?.trim();
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    filters.push(or(ilike(customers.name, pattern), ilike(customers.businessName, pattern), ilike(customers.phone, pattern), ilike(customers.phone2, pattern), ilike(customers.whatsapp, pattern))!);
  }
  const where = and(...filters);
  const rows = await db.select().from(customers).where(where).orderBy(asc(customers.name), asc(customers.id)).limit(pageSize).offset((page - 1) * pageSize);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(customers).where(where);
  return context.json({ data: rows.map((row) => present(row, principal)), page, pageSize, total });
});

customersRoutes.get("/customers/:id", view, async (context) => {
  const principal = getPrincipal(context);
  const [row] = await db.select().from(customers).where(and(eq(customers.id, paramId(context)), eq(customers.businessId, principal.businessId!))).limit(1);
  return row ? context.json(present(row, principal)) : apiError(context, 404, "NOT_FOUND", "Customer not found");
});

customersRoutes.post("/customers", manage, validateJson(customerSchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  const problem = await referenceProblem(principal.businessId!, input);
  if (problem) return apiError(context, 400, "INVALID_REFERENCE", problem);
  try {
    const [row] = await db.insert(customers).values({ ...input, businessId: principal.businessId!, ...createdByActor(principal) }).returning();
    await auditPrincipal(context, principal, "customer", row.id, "create", null, forAudit(row));
    return context.json(present(row, principal), 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

/** The till's "add customer": a name and a phone, nothing else, for people who may create but not manage customers. */
customersRoutes.post("/customers/quick", create, validateJson(quickCustomerSchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  const [row] = await db.insert(customers).values({ ...input, businessId: principal.businessId!, ...createdByActor(principal) }).returning();
  await auditPrincipal(context, principal, "customer", row.id, "create", null, forAudit(row));
  return context.json(present(row, principal), 201);
});

customersRoutes.put("/customers/:id", manage, validateJson(customerSchema), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const input = context.req.valid("json");
  const [before] = await db.select().from(customers).where(and(eq(customers.id, id), eq(customers.businessId, principal.businessId!))).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Customer not found");
  const problem = await referenceProblem(principal.businessId!, input);
  if (problem) return apiError(context, 400, "INVALID_REFERENCE", problem);
  try {
    const [after] = await db.update(customers).set({ ...input, active: input.active ?? before.active, ...updatedByActor(principal) })
      .where(and(eq(customers.id, id), eq(customers.businessId, principal.businessId!))).returning();
    await auditPrincipal(context, principal, "customer", id, "update", forAudit(before), forAudit(after));
    return context.json(present(after, principal));
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

/** A customer with a history is never deleted: archiving keeps every invoice and ledger row pointing at them. */
customersRoutes.delete("/customers/:id", manage, async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const [row] = await db.update(customers).set({ active: false, ...updatedByActor(principal) })
    .where(and(eq(customers.id, id), eq(customers.businessId, principal.businessId!))).returning({ id: customers.id });
  if (!row) return apiError(context, 404, "NOT_FOUND", "Customer not found");
  await auditPrincipal(context, principal, "customer", id, "archive", { active: true }, { active: false });
  return context.json({ id, active: false });
});

// ---------------------------------------------------------------- areas and groups

customersRoutes.get("/areas", view, async (context) => {
  return context.json(await db.select().from(areas).where(eq(areas.businessId, getPrincipal(context).businessId!)).orderBy(areas.name));
});

customersRoutes.post("/areas", manage, validateJson(areaSchema), async (context) => {
  const principal = getPrincipal(context);
  try {
    const [row] = await db.insert(areas).values({ ...context.req.valid("json"), businessId: principal.businessId!, ...createdByActor(principal) }).returning();
    await auditPrincipal(context, principal, "area", row.id, "create", null, row);
    return context.json(row, 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

customersRoutes.put("/areas/:id", manage, validateJson(areaSchema), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const [before] = await db.select().from(areas).where(and(eq(areas.id, id), eq(areas.businessId, principal.businessId!))).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Area not found");
  try {
    const input = context.req.valid("json");
    const [after] = await db.update(areas).set({ ...input, active: input.active ?? before.active, ...updatedByActor(principal) }).where(eq(areas.id, id)).returning();
    await auditPrincipal(context, principal, "area", id, "update", before, after);
    return context.json(after);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

customersRoutes.get("/customer-groups", view, async (context) => {
  return context.json(await db.select().from(customerGroups).where(eq(customerGroups.businessId, getPrincipal(context).businessId!)).orderBy(customerGroups.name));
});

customersRoutes.post("/customer-groups", manage, validateJson(customerGroupSchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  const problem = await referenceProblem(principal.businessId!, { areaId: null, groupId: null, priceListId: input.priceListId });
  if (problem) return apiError(context, 400, "INVALID_REFERENCE", problem);
  try {
    const [row] = await db.insert(customerGroups).values({ ...input, businessId: principal.businessId!, ...createdByActor(principal) }).returning();
    await auditPrincipal(context, principal, "customer_group", row.id, "create", null, row);
    return context.json(row, 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

customersRoutes.put("/customer-groups/:id", manage, validateJson(customerGroupSchema), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const input = context.req.valid("json");
  const [before] = await db.select().from(customerGroups).where(and(eq(customerGroups.id, id), eq(customerGroups.businessId, principal.businessId!))).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Group not found");
  const problem = await referenceProblem(principal.businessId!, { areaId: null, groupId: null, priceListId: input.priceListId });
  if (problem) return apiError(context, 400, "INVALID_REFERENCE", problem);
  try {
    const [after] = await db.update(customerGroups).set({ ...input, active: input.active ?? before.active, ...updatedByActor(principal) }).where(eq(customerGroups.id, id)).returning();
    await auditPrincipal(context, principal, "customer_group", id, "update", before, after);
    return context.json(after);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

// ---------------------------------------------------------------- the till's customer cache

const changesPageSize = 500;

/**
 * Customers changed after version `since`, in the slim form a till keeps: no CNIC, notes or email, and the price list already
 * resolved (own, else the group's). Archived customers are included so the till can drop them. A page ends on a whole version.
 */
customersRoutes.get("/pos/customers/changes", view, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const since = Math.max(0, Math.trunc(Number(context.req.query("since") ?? 0)) || 0);
  const [counter] = await db.select().from(dataVersions).where(and(eq(dataVersions.businessId, businessId), eq(dataVersions.dataset, "customers"))).limit(1);
  const current = counter?.version ?? 0;
  if (since >= current) return context.json({ version: current, hasMore: false, customers: [] });

  const where = and(eq(customers.businessId, businessId), gt(customers.changeVersion, since), lte(customers.changeVersion, current));
  const head = await db.select().from(customers).where(where).orderBy(asc(customers.changeVersion), asc(customers.id)).limit(changesPageSize + 1);
  let page = head.slice(0, changesPageSize);
  let hasMore = head.length > changesPageSize;
  if (hasMore) {
    const last = page[page.length - 1];
    const rest = await db.select().from(customers).where(and(where, eq(customers.changeVersion, last.changeVersion), sql`${customers.id} > ${last.id}`)).orderBy(asc(customers.id));
    page = [...page, ...rest];
    const [more] = await db.select({ id: customers.id }).from(customers).where(and(where, gt(customers.changeVersion, last.changeVersion))).limit(1);
    hasMore = Boolean(more);
  }
  const groups = await db.select().from(customerGroups).where(eq(customerGroups.businessId, businessId));
  const groupList = new Map(groups.map((group) => [group.id, group.priceListId]));
  const seesBalance = hasPermission(principal, "customers.ledger");
  return context.json({
    version: hasMore ? page[page.length - 1].changeVersion : current,
    hasMore,
    customers: page.map((row) => ({
      id: row.id, name: row.name, businessName: row.businessName, phone: row.phone, phone2: row.phone2, whatsapp: row.whatsapp, address: row.address,
      areaId: row.areaId, groupId: row.groupId, registered: row.registered, ntn: row.ntn, strn: row.strn,
      priceListId: row.priceListId ?? (row.groupId ? groupList.get(row.groupId) ?? null : null),
      creditLimitPaisa: row.creditLimitPaisa, termsDays: row.termsDays, active: row.active,
      // Zero for a till user who may not see the khata; the server still enforces the real limit.
      balancePaisa: seesBalance ? row.balancePaisa : 0,
    })),
  });
});
