import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  brands, businessSettings, businesses, branches, categories, dataVersions, heldSales, paymentMethods, priceListItems, priceLists, products, roles, shifts,
  taxCategories, terminals, units,
} from "../../../db/schema";
import { holdSaleSchema, maxHeldSalesPerTerminal } from "../../../shared/schemas/heldSales";
import { db } from "../../lib/db";
import { apiError, paramId } from "../../lib/http";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { canSeeCost, loadProductViews, quantityText } from "../products/service";
import { resolveSalesLocationId } from "../sales/location";

export const posRoutes = new Hono();

const datasets = ["catalogue", "reference", "settings", "access", "customers"] as const;

/** The change counter of every dataset; 0 for one that has never changed. A terminal compares these with what it holds. */
async function readVersions(businessId: string) {
  const rows = await db.select().from(dataVersions).where(eq(dataVersions.businessId, businessId));
  return Object.fromEntries(datasets.map((dataset) => [dataset, rows.find((row) => row.dataset === dataset)?.version ?? 0])) as Record<(typeof datasets)[number], number>;
}

const use = requirePermission("sales.create");

posRoutes.get("/pos/data-versions", use, async (context) => {
  return context.json(await readVersions(getPrincipal(context).businessId!));
});

/** Everything the till needs besides the product catalogue, in one call (technical-plan 5.7). */
posRoutes.get("/pos/bootstrap", use, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const versions = await readVersions(businessId);
  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
  const [settings] = await db.select().from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1);
  const [terminal] = principal.terminalId
    ? await db.select().from(terminals).where(and(eq(terminals.id, principal.terminalId), eq(terminals.businessId, businessId))).limit(1)
    : [];
  const salesLocationId = terminal ? await resolveSalesLocationId(terminal) : null;
  const [branch] = terminal ? await db.select().from(branches).where(eq(branches.id, terminal.branchId)).limit(1) : [];
  const [role] = await db.select({ name: roles.name, maxDiscountBps: roles.maxDiscountBps }).from(roles).where(eq(roles.id, principal.roleId!)).limit(1);
  const [openShift] = terminal
    ? await db.select().from(shifts).where(and(eq(shifts.terminalId, terminal.id), eq(shifts.status, "open"))).limit(1)
    : [];

  const [taxes, unitRows, categoryRows, brandRows, methods, lists] = await Promise.all([
    db.select({ id: taxCategories.id, name: taxCategories.name, kind: taxCategories.kind, rateBps: taxCategories.rateBps }).from(taxCategories)
      .where(and(eq(taxCategories.businessId, businessId), eq(taxCategories.active, true))).orderBy(asc(taxCategories.name)),
    db.select({ id: units.id, name: units.name, shortName: units.shortName }).from(units)
      .where(and(eq(units.businessId, businessId), eq(units.active, true))).orderBy(asc(units.name)),
    db.select({ id: categories.id, name: categories.name, parentId: categories.parentId }).from(categories)
      .where(and(eq(categories.businessId, businessId), eq(categories.active, true))).orderBy(asc(categories.name)),
    db.select({ id: brands.id, name: brands.name }).from(brands)
      .where(and(eq(brands.businessId, businessId), eq(brands.active, true))).orderBy(asc(brands.name)),
    db.select({ id: paymentMethods.id, code: paymentMethods.code, name: paymentMethods.name, kind: paymentMethods.kind }).from(paymentMethods)
      .where(and(eq(paymentMethods.businessId, businessId), eq(paymentMethods.active, true))).orderBy(asc(paymentMethods.sortOrder)),
    db.select({ id: priceLists.id, name: priceLists.name }).from(priceLists)
      .where(and(eq(priceLists.businessId, businessId), eq(priceLists.active, true))).orderBy(asc(priceLists.name)),
  ]);

  return context.json({
    versions,
    business: business && {
      id: business.id, tradeName: business.tradeName, legalName: business.legalName, address: business.address, phone: business.phone,
      ntn: business.ntn, strn: business.strn, receiptFooter: business.receiptFooter, logoUrl: business.logoUrl,
    },
    branch: branch && { id: branch.id, name: branch.name, code: branch.code },
    terminal: terminal && {
      id: terminal.id, name: terminal.name, defaultPrintFormat: terminal.defaultPrintFormat, salesLocationId,
    },
    settings: settings && {
      currency: settings.currency, timezone: settings.timezone, dateFormat: settings.dateFormat, taxMode: settings.taxMode,
      cashRoundingPaisa: settings.cashRoundingPaisa, allowNegativeStock: settings.allowNegativeStock, autoPrintReceipt: settings.autoPrintReceipt,
      returnWindowDays: settings.returnWindowDays,
    },
    user: {
      id: getActorId(principal), name: principal.activeUserName, email: principal.activeUserEmail, roleName: role?.name ?? null,
      maxDiscountBps: role?.maxDiscountBps ?? 0, permissions: [...principal.permissions],
    },
    shift: openShift ? { id: openShift.id, openedAt: openShift.openedAt, openingFloatPaisa: openShift.openingFloatPaisa } : null,
    taxCategories: taxes,
    units: unitRows,
    categories: categoryRows,
    brands: brandRows,
    paymentMethods: methods,
    priceLists: lists,
  });
});

/** The items of one price list, for a till that has just picked a customer on that tier. Quantities are text, as everywhere in the API. */
posRoutes.get("/pos/price-lists/:id", use, async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const [list] = await db.select().from(priceLists).where(and(eq(priceLists.id, id), eq(priceLists.businessId, principal.businessId!), eq(priceLists.active, true))).limit(1);
  if (!list) return apiError(context, 404, "NOT_FOUND", "Price list not found");
  const items = await db.select().from(priceListItems).where(and(eq(priceListItems.priceListId, id), eq(priceListItems.businessId, principal.businessId!)));
  return context.json({ id: list.id, name: list.name, items: items.map((item) => ({ variantId: item.variantId, unitId: item.unitId, minQuantity: quantityText(item.minQuantity), pricePaisa: item.pricePaisa })) });
});

const changesPageSize = 500;

/**
 * Products that changed after version `since` (0 for the first full load), archived ones included so a terminal can drop
 * them. A page ends on a whole version, never in the middle of one, so a bulk import is never split between two calls.
 * The terminal stores the returned `version` and asks again from there.
 */
posRoutes.get("/pos/products/changes", requirePermission("catalog.view"), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const since = Math.max(0, Math.trunc(Number(context.req.query("since") ?? 0)) || 0);
  const { catalogue: current } = await readVersions(businessId);
  if (since >= current) return context.json({ version: current, hasMore: false, products: [] });

  const where = and(eq(products.businessId, businessId), gt(products.catalogVersion, since), lte(products.catalogVersion, current));
  const head = await db.select({ id: products.id, version: products.catalogVersion }).from(products).where(where)
    .orderBy(asc(products.catalogVersion), asc(products.id)).limit(changesPageSize + 1);
  let page = head.slice(0, changesPageSize);
  let hasMore = head.length > changesPageSize;
  if (hasMore) {
    const lastVersion = page[page.length - 1].version;
    // Finish the version the page ended in.
    const rest = await db.select({ id: products.id, version: products.catalogVersion }).from(products)
      .where(and(where, eq(products.catalogVersion, lastVersion), sql`${products.id} > ${page[page.length - 1].id}`)).orderBy(asc(products.id));
    page = [...page, ...rest];
    const [more] = await db.select({ id: products.id }).from(products).where(and(where, gt(products.catalogVersion, lastVersion))).limit(1);
    hasMore = Boolean(more);
  }
  const version = hasMore ? page[page.length - 1].version : current;
  return context.json({ version, hasMore, products: await loadProductViews(businessId, page.map((row) => row.id), canSeeCost(principal)) });
});

// ---------------------------------------------------------------- held sales

posRoutes.get("/held-sales", use, async (context) => {
  const principal = getPrincipal(context);
  if (!principal.terminalId) return apiError(context, 400, "TERMINAL_REQUIRED", "Open the POS on a registered terminal");
  const rows = await db.select({ id: heldSales.id, name: heldSales.name, totalPaisa: heldSales.totalPaisa, heldBy: heldSales.heldBy, createdAt: heldSales.createdAt })
    .from(heldSales).where(and(eq(heldSales.businessId, principal.businessId!), eq(heldSales.terminalId, principal.terminalId))).orderBy(asc(heldSales.createdAt));
  return context.json(rows);
});

posRoutes.post("/held-sales", use, validateJson(holdSaleSchema), async (context) => {
  const principal = getPrincipal(context);
  if (!principal.terminalId) return apiError(context, 400, "TERMINAL_REQUIRED", "Open the POS on a registered terminal");
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  const [{ held }] = await db.select({ held: sql<number>`count(*)::int` }).from(heldSales)
    .where(and(eq(heldSales.businessId, businessId), eq(heldSales.terminalId, principal.terminalId)));
  if (held >= maxHeldSalesPerTerminal) return apiError(context, 409, "TOO_MANY_HELD", "This terminal has too many held sales. Recall or discard some first.");
  const [created] = await db.insert(heldSales).values({
    businessId, terminalId: principal.terminalId, heldBy: getActorId(principal), name: input.name, cart: input.cart, totalPaisa: input.totalPaisa,
  }).returning({ id: heldSales.id, name: heldSales.name, totalPaisa: heldSales.totalPaisa, heldBy: heldSales.heldBy, createdAt: heldSales.createdAt });
  return context.json(created, 201);
});

/** Recalling hands the cart back and removes it in one step, so two tills cannot both pick it up. */
posRoutes.post("/held-sales/:id/recall", use, async (context) => {
  const principal = getPrincipal(context);
  const [recalled] = await db.delete(heldSales)
    .where(and(eq(heldSales.businessId, principal.businessId!), eq(heldSales.id, paramId(context)))).returning();
  return recalled ? context.json({ id: recalled.id, name: recalled.name, cart: recalled.cart, totalPaisa: recalled.totalPaisa }) : apiError(context, 404, "NOT_FOUND", "Held sale not found");
});

posRoutes.delete("/held-sales/:id", use, async (context) => {
  const principal = getPrincipal(context);
  const [removed] = await db.delete(heldSales)
    .where(and(eq(heldSales.businessId, principal.businessId!), eq(heldSales.id, paramId(context)))).returning({ id: heldSales.id });
  return removed ? context.json({ id: removed.id }) : apiError(context, 404, "NOT_FOUND", "Held sale not found");
});
