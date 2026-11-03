import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { brands, categories, productUnits, productVariants, products, taxCategories, units } from "../../../db/schema";
import { importColumns } from "../../../shared/productImport";
import { toCsv } from "../../../shared/csv";
import { toPlainRupees } from "../../../shared/money";
import { productSchema } from "../../../shared/schemas/catalogue";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { conflictOrThrow } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { analyseImportFile, commitImport, describeNewReferences, ImportFileError } from "./importer";
import {
  archiveProduct, canSeeCost, createProduct, escapeLike, findReferenceProblem, loadProductViews, matchesProductText,
  ProductRuleError, quantityText, updateProduct,
} from "./service";

export const productsRoutes = new Hono();

const view = requirePermission("catalog.view");
const manage = requirePermission("catalog.manage");
const importCsvSchema = z.object({ csv: z.string().min(1).max(2_000_000) });

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
}

const pageParams = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});

productsRoutes.get("/products", view, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const { page, pageSize } = pageParams((name) => context.req.query(name));
  const status = context.req.query("active");
  const search = context.req.query("q")?.trim();
  const categoryId = context.req.query("categoryId");
  const brandId = context.req.query("brandId");
  const conditions = and(
    eq(products.businessId, businessId),
    status === "all" ? undefined : eq(products.active, status !== "false"),
    categoryId ? eq(products.categoryId, categoryId) : undefined,
    brandId ? eq(products.brandId, brandId) : undefined,
    search ? matchesProductText(businessId, `%${escapeLike(search)}%`) : undefined,
  );
  const [ids, [{ total }]] = await Promise.all([
    db.select({ id: products.id }).from(products).where(conditions).orderBy(products.name, products.id).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ total: count() }).from(products).where(conditions),
  ]);
  const data = await loadProductViews(businessId, ids.map((row) => row.id), canSeeCost(principal));
  return context.json({ data, page, pageSize, total });
});

// Declared before /products/:id so "lookup" and "export" are not read as an id.
productsRoutes.get("/products/lookup", view, async (context) => {
  const principal = getPrincipal(context);
  const barcode = context.req.query("barcode")?.trim();
  if (!barcode) return apiError(context, 400, "BARCODE_REQUIRED", "Give a barcode to look up");
  const [match] = await db.select({
    productId: productVariants.productId, variantId: productUnits.variantId, productUnitId: productUnits.id,
    unitId: productUnits.unitId, factorToBase: productUnits.factorToBase,
  }).from(productUnits).innerJoin(productVariants, eq(productVariants.id, productUnits.variantId))
    .where(and(eq(productUnits.businessId, principal.businessId!), eq(productUnits.barcode, barcode))).limit(1);
  if (!match) return apiError(context, 404, "NOT_FOUND", "No product has this barcode");
  const [product] = await loadProductViews(principal.businessId!, [match.productId], canSeeCost(principal));
  return context.json({ ...match, factorToBase: quantityText(match.factorToBase), product });
});

productsRoutes.get("/products/export", requirePermission("products.export"), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const withCost = canSeeCost(principal);
  const [productRows, variantRows, unitRows, categoryRows, brandRows, unitDefinitions, taxRows] = await Promise.all([
    db.select().from(products).where(and(eq(products.businessId, businessId), eq(products.active, true))).orderBy(products.name),
    db.select().from(productVariants).where(and(eq(productVariants.businessId, businessId), eq(productVariants.active, true))).orderBy(productVariants.sku),
    db.select().from(productUnits).where(eq(productUnits.businessId, businessId)),
    db.select().from(categories).where(eq(categories.businessId, businessId)),
    db.select().from(brands).where(eq(brands.businessId, businessId)),
    db.select().from(units).where(eq(units.businessId, businessId)),
    db.select({ id: taxCategories.id, name: taxCategories.name }).from(taxCategories).where(eq(taxCategories.businessId, businessId)),
  ]);
  const unitName = new Map(unitDefinitions.map((unit) => [unit.id, unit.name]));
  const brandName = new Map(brandRows.map((brand) => [brand.id, brand.name]));
  const categoryById = new Map(categoryRows.map((category) => [category.id, category]));
  const categoryPath = (id: string | null) => {
    const names: string[] = [];
    for (let cursor = id ? categoryById.get(id) : undefined; cursor; cursor = cursor.parentId ? categoryById.get(cursor.parentId) : undefined) names.unshift(cursor.name);
    return names.join(" > ");
  };
  const unitsByVariant = groupBy(unitRows, (unit) => unit.variantId);
  const variantsByProduct = groupBy(variantRows, (variant) => variant.productId);
  const taxNames = new Map(taxRows.map((tax) => [tax.id, tax.name]));

  const rows: Array<Array<string | number | null>> = [[...importColumns]];
  for (const product of productRows) {
    for (const variant of variantsByProduct.get(product.id) ?? []) {
      const variantUnits = unitsByVariant.get(variant.id) ?? [];
      const base = variantUnits.find((unit) => unit.isBase);
      const alt = variantUnits.filter((unit) => !unit.isBase).sort((a, b) => Number(a.factorToBase) - Number(b.factorToBase))[0];
      rows.push([
        variant.sku, product.name, variant.variantName, categoryPath(product.categoryId), product.brandId ? brandName.get(product.brandId) ?? "" : "",
        product.taxCategoryId ? taxNames.get(product.taxCategoryId) ?? "" : "", product.hsCode ?? "", unitName.get(product.baseUnitId) ?? "",
        base ? toPlainRupees(base.salePricePaisa) : "", withCost ? toPlainRupees(variant.costPaisa) : "", base?.barcode ?? "",
        quantityText(variant.reorderLevel), quantityText(variant.reorderQuantity),
        alt ? unitName.get(alt.unitId) ?? "" : "", alt ? quantityText(alt.factorToBase) : "", alt?.barcode ?? "", alt ? toPlainRupees(alt.salePricePaisa) : "",
      ]);
    }
  }
  await auditPrincipal(context, principal, "product", "export", "export", null, { variants: rows.length - 1 });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  return new Response(toCsv(rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="products-${today}.csv"` },
  });
});

productsRoutes.post("/products/import/preview", requirePermission("products.import"), validateJson(importCsvSchema), async (context) => {
  const principal = getPrincipal(context);
  try {
    const analysis = await analyseImportFile(db, principal, context.req.valid("json").csv);
    const { newCategories, newBrands } = await describeNewReferences(db, principal.businessId!, analysis);
    return context.json({
      canImport: analysis.issues.length === 0,
      issues: analysis.issues,
      summary: {
        products: analysis.products.length,
        variantsToCreate: analysis.variantsToCreate,
        variantsToUpdate: analysis.variantsToUpdate,
        newCategories,
        newBrands,
      },
    });
  } catch (error) {
    if (error instanceof ImportFileError) return apiError(context, 400, "INVALID_CSV", error.message);
    throw error;
  }
});

productsRoutes.post("/products/import", requirePermission("products.import"), idempotent(), validateJson(importCsvSchema), async (context) => {
  const principal = getPrincipal(context);
  try {
    const result = await db.transaction(async (tx) => {
      const analysis = await analyseImportFile(tx, principal, context.req.valid("json").csv);
      if (analysis.issues.length) return { issues: analysis.issues };
      return { result: await commitImport(tx, principal, analysis) };
    });
    if ("issues" in result) {
      return context.json({ error: { code: "IMPORT_HAS_ERRORS", message: "Fix the listed rows and import again", details: result.issues } }, 422);
    }
    await auditPrincipal(context, principal, "product", "import", "import", null, result.result);
    return context.json(result.result, 201);
  } catch (error) {
    if (error instanceof ImportFileError) return apiError(context, 400, "INVALID_CSV", error.message);
    return conflictOrThrow(context, error);
  }
});

productsRoutes.get("/products/:id", view, async (context) => {
  const principal = getPrincipal(context);
  const [product] = await loadProductViews(principal.businessId!, [paramId(context)], canSeeCost(principal));
  return product ? context.json(product) : apiError(context, 404, "NOT_FOUND", "Product not found");
});

productsRoutes.post("/products", manage, validateJson(productSchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  const problem = await findReferenceProblem(principal.businessId!, input);
  if (problem) return apiError(context, 400, "INVALID_REFERENCE", problem);
  try {
    const id = await db.transaction((tx) => createProduct(tx, principal, input));
    const [created] = await loadProductViews(principal.businessId!, [id], true);
    await auditPrincipal(context, principal, "product", id, "create", null, created as unknown as Record<string, unknown>);
    const [visible] = await loadProductViews(principal.businessId!, [id], canSeeCost(principal));
    return context.json(visible, 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

productsRoutes.put("/products/:id", manage, validateJson(productSchema), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const input = context.req.valid("json");
  const [before] = await loadProductViews(principal.businessId!, [id], true);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Product not found");
  const problem = await findReferenceProblem(principal.businessId!, input);
  if (problem) return apiError(context, 400, "INVALID_REFERENCE", problem);
  try {
    await db.transaction((tx) => updateProduct(tx, principal, id, input));
  } catch (error) {
    if (error instanceof ProductRuleError) return apiError(context, error.status, error.code, error.message);
    return conflictOrThrow(context, error);
  }
  const [after] = await loadProductViews(principal.businessId!, [id], true);
  await auditPrincipal(context, principal, "product", id, "update", before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
  const [visible] = await loadProductViews(principal.businessId!, [id], canSeeCost(principal));
  return context.json(visible);
});

productsRoutes.delete("/products/:id", manage, async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const archived = await db.transaction((tx) => archiveProduct(tx, principal, id));
  if (!archived) return apiError(context, 404, "NOT_FOUND", "Product not found");
  await auditPrincipal(context, principal, "product", id, "archive", { active: true }, { active: false });
  return context.json({ id, active: false });
});

