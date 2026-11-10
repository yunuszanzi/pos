import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { brands, categories, priceListItems, priceLists, productUnits, productVariants, products, taxCategories, units } from "../../../db/schema";
import { brandSchema, categorySchema, priceListSchema, taxCategorySchema, unitSchema } from "../../../shared/schemas/catalogue";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { conflictOrThrow } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { createdByActor, getPrincipal, requirePermission, updatedByActor } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { quantityText } from "../products/service";

export const catalogueRoutes = new Hono();

const view = requirePermission("catalog.view");
const manage = requirePermission("catalog.manage");

// ---------------------------------------------------------------- categories

catalogueRoutes.get("/categories", view, async (context) => {
  const principal = getPrincipal(context);
  return context.json(await db.select().from(categories).where(eq(categories.businessId, principal.businessId!)).orderBy(categories.name));
});

catalogueRoutes.post("/categories", manage, validateJson(categorySchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  if (input.parentId) {
    const [parent] = await db.select({ id: categories.id }).from(categories)
      .where(and(eq(categories.id, input.parentId), eq(categories.businessId, principal.businessId!))).limit(1);
    if (!parent) return apiError(context, 400, "INVALID_PARENT", "Choose a parent category in this business");
  }
  try {
    const [category] = await db.insert(categories).values({ ...input, businessId: principal.businessId!, ...createdByActor(principal) }).returning();
    await auditPrincipal(context, principal, "category", category.id, "create", null, category);
    return context.json(category, 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

catalogueRoutes.put("/categories/:id", manage, validateJson(categorySchema.partial()), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const input = context.req.valid("json");
  const all = await db.select().from(categories).where(eq(categories.businessId, principal.businessId!));
  const before = all.find((category) => category.id === id);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Category not found");
  if (input.parentId) {
    // Walk up from the proposed parent: reaching this category would make a loop.
    const parents = new Map(all.map((category) => [category.id, category.parentId]));
    for (let cursor: string | null | undefined = input.parentId; cursor; cursor = parents.get(cursor)) {
      if (cursor === id) return apiError(context, 400, "INVALID_PARENT", "A category cannot be placed inside itself");
    }
    if (!parents.has(input.parentId)) return apiError(context, 400, "INVALID_PARENT", "Choose a parent category in this business");
  }
  try {
    const [after] = await db.update(categories).set({ ...input, ...updatedByActor(principal) })
      .where(and(eq(categories.id, id), eq(categories.businessId, principal.businessId!))).returning();
    await auditPrincipal(context, principal, "category", id, "update", before, after);
    return context.json(after);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

// ---------------------------------------------------------------- brands

catalogueRoutes.get("/brands", view, async (context) => {
  const principal = getPrincipal(context);
  return context.json(await db.select().from(brands).where(eq(brands.businessId, principal.businessId!)).orderBy(brands.name));
});

catalogueRoutes.post("/brands", manage, validateJson(brandSchema), async (context) => {
  const principal = getPrincipal(context);
  try {
    const [brand] = await db.insert(brands).values({ ...context.req.valid("json"), businessId: principal.businessId!, ...createdByActor(principal) }).returning();
    await auditPrincipal(context, principal, "brand", brand.id, "create", null, brand);
    return context.json(brand, 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

catalogueRoutes.put("/brands/:id", manage, validateJson(brandSchema.partial()), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const [before] = await db.select().from(brands).where(and(eq(brands.id, id), eq(brands.businessId, principal.businessId!))).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Brand not found");
  try {
    const [after] = await db.update(brands).set({ ...context.req.valid("json"), ...updatedByActor(principal) }).where(eq(brands.id, id)).returning();
    await auditPrincipal(context, principal, "brand", id, "update", before, after);
    return context.json(after);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

// ---------------------------------------------------------------- tax categories

catalogueRoutes.get("/tax-categories", view, async (context) => {
  const principal = getPrincipal(context);
  return context.json(await db.select().from(taxCategories).where(eq(taxCategories.businessId, principal.businessId!)).orderBy(taxCategories.name));
});

catalogueRoutes.post("/tax-categories", manage, validateJson(taxCategorySchema), async (context) => {
  const principal = getPrincipal(context);
  try {
    const [created] = await db.insert(taxCategories).values({ ...context.req.valid("json"), businessId: principal.businessId!, ...createdByActor(principal) }).returning();
    await auditPrincipal(context, principal, "tax_category", created.id, "create", null, created);
    return context.json(created, 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

catalogueRoutes.put("/tax-categories/:id", manage, validateJson(taxCategorySchema.partial()), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const [before] = await db.select().from(taxCategories).where(and(eq(taxCategories.id, id), eq(taxCategories.businessId, principal.businessId!))).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Tax category not found");
  try {
    const [after] = await db.update(taxCategories).set({ ...context.req.valid("json"), ...updatedByActor(principal) }).where(eq(taxCategories.id, id)).returning();
    await auditPrincipal(context, principal, "tax_category", id, "update", before, after);
    return context.json(after);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

// ---------------------------------------------------------------- units

catalogueRoutes.get("/units", view, async (context) => {
  const principal = getPrincipal(context);
  return context.json(await db.select().from(units).where(eq(units.businessId, principal.businessId!)).orderBy(units.name));
});

catalogueRoutes.post("/units", manage, validateJson(unitSchema), async (context) => {
  const principal = getPrincipal(context);
  try {
    const [unit] = await db.insert(units).values({ ...context.req.valid("json"), businessId: principal.businessId!, ...createdByActor(principal) }).returning();
    await auditPrincipal(context, principal, "unit", unit.id, "create", null, unit);
    return context.json(unit, 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

catalogueRoutes.put("/units/:id", manage, validateJson(unitSchema.partial()), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const [before] = await db.select().from(units).where(and(eq(units.id, id), eq(units.businessId, principal.businessId!))).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Unit not found");
  try {
    const [after] = await db.update(units).set({ ...context.req.valid("json"), ...updatedByActor(principal) }).where(eq(units.id, id)).returning();
    await auditPrincipal(context, principal, "unit", id, "update", before, after);
    return context.json(after);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

// ---------------------------------------------------------------- price lists

async function loadPriceList(businessId: string, id: string) {
  const [list] = await db.select().from(priceLists).where(and(eq(priceLists.id, id), eq(priceLists.businessId, businessId))).limit(1);
  if (!list) return null;
  const rows = await db.select({
    id: priceListItems.id, variantId: priceListItems.variantId, unitId: priceListItems.unitId, minQuantity: priceListItems.minQuantity,
    pricePaisa: priceListItems.pricePaisa, sku: productVariants.sku, variantName: productVariants.variantName, productName: products.name,
  }).from(priceListItems)
    .innerJoin(productVariants, eq(productVariants.id, priceListItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(priceListItems.priceListId, id))
    .orderBy(products.name, productVariants.sku, priceListItems.unitId, priceListItems.minQuantity);
  // The units each SKU is sold in, so the editor can offer them without another request per row.
  const unitRows = rows.length
    ? await db.select({ variantId: productUnits.variantId, unitId: productUnits.unitId }).from(productUnits)
      .where(inArray(productUnits.variantId, [...new Set(rows.map((row) => row.variantId))]))
    : [];
  const items = rows.map((row) => ({
    ...row,
    minQuantity: quantityText(row.minQuantity),
    unitIds: unitRows.filter((unit) => unit.variantId === row.variantId).map((unit) => unit.unitId),
  }));
  return { ...list, items };
}

/** Every item's unit must be one the variant is actually sold in. */
async function unknownPriceListUnits(businessId: string, items: Array<{ variantId: string; unitId: string }>) {
  if (!items.length) return [];
  const known = await db.select({ variantId: productUnits.variantId, unitId: productUnits.unitId }).from(productUnits)
    .where(and(eq(productUnits.businessId, businessId), inArray(productUnits.variantId, [...new Set(items.map((item) => item.variantId))])));
  const valid = new Set(known.map((row) => `${row.variantId}|${row.unitId}`));
  return items.filter((item) => !valid.has(`${item.variantId}|${item.unitId}`));
}

catalogueRoutes.get("/price-lists", view, async (context) => {
  const principal = getPrincipal(context);
  return context.json(await db.select().from(priceLists).where(eq(priceLists.businessId, principal.businessId!)).orderBy(priceLists.name));
});

catalogueRoutes.get("/price-lists/:id", view, async (context) => {
  const principal = getPrincipal(context);
  const list = await loadPriceList(principal.businessId!, paramId(context));
  return list ? context.json(list) : apiError(context, 404, "NOT_FOUND", "Price list not found");
});

catalogueRoutes.post("/price-lists", manage, validateJson(priceListSchema), async (context) => {
  const principal = getPrincipal(context);
  const { items, ...fields } = context.req.valid("json");
  if ((await unknownPriceListUnits(principal.businessId!, items)).length) {
    return apiError(context, 400, "INVALID_PRICE_ITEM", "Each price must use a product and a unit that product is sold in");
  }
  try {
    const created = await db.transaction(async (tx) => {
      const [list] = await tx.insert(priceLists).values({ ...fields, businessId: principal.businessId!, ...createdByActor(principal) }).returning();
      if (items.length) {
        await tx.insert(priceListItems).values(items.map((item) => ({ ...item, priceListId: list.id, businessId: principal.businessId!, ...createdByActor(principal) })));
      }
      return list;
    });
    await auditPrincipal(context, principal, "price_list", created.id, "create", null, { name: created.name, items: items.length });
    return context.json({ ...created, items }, 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

catalogueRoutes.put("/price-lists/:id", manage, validateJson(priceListSchema), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const before = await loadPriceList(principal.businessId!, id);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Price list not found");
  const { items, ...fields } = context.req.valid("json");
  if ((await unknownPriceListUnits(principal.businessId!, items)).length) {
    return apiError(context, 400, "INVALID_PRICE_ITEM", "Each price must use a product and a unit that product is sold in");
  }
  try {
    await db.transaction(async (tx) => {
      await tx.update(priceLists).set({ ...fields, ...updatedByActor(principal) }).where(eq(priceLists.id, id));
      await tx.delete(priceListItems).where(eq(priceListItems.priceListId, id));
      if (items.length) {
        await tx.insert(priceListItems).values(items.map((item) => ({ ...item, priceListId: id, businessId: principal.businessId!, ...createdByActor(principal) })));
      }
    });
    const after = await loadPriceList(principal.businessId!, id);
    await auditPrincipal(context, principal, "price_list", id, "update", { name: before.name, items: before.items.length }, { name: after!.name, items: items.length });
    return context.json(after);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});
