import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { brands, categories, productUnits, productVariants, products, taxCategories, units } from "../../../db/schema";
import { csvToRecords, parseCsv } from "../../../shared/csv";
import { analyseProductImport, type ImportAnalysis, type ImportLookups } from "../../../shared/productImport";
import type { db } from "../../lib/db";
import { createdByActor, updatedByActor, type Principal } from "../../lib/permissions";
import { canSeeCost } from "./service";

type Executor = Pick<typeof db, "select" | "insert" | "update">;

const lower = (text: string) => text.trim().toLowerCase();
const pathKey = (path: string[]) => path.map(lower).join(">");

async function buildLookups(executor: Executor, principal: Principal, skus: string[], barcodes: string[]): Promise<ImportLookups> {
  const businessId = principal.businessId!;
  const [taxRows, unitRows] = await Promise.all([
    executor.select({ id: taxCategories.id, name: taxCategories.name }).from(taxCategories).where(eq(taxCategories.businessId, businessId)),
    executor.select({ id: units.id, name: units.name, shortName: units.shortName }).from(units).where(eq(units.businessId, businessId)),
  ]);
  const existingSkus: ImportLookups["existingSkus"] = new Map();
  if (skus.length) {
    const rows = await executor.select({
      sku: productVariants.sku, variantId: productVariants.id, productId: productVariants.productId, baseUnitId: products.baseUnitId,
    }).from(productVariants).innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(eq(productVariants.businessId, businessId), inArray(sql`lower(${productVariants.sku})`, skus.map(lower))));
    for (const row of rows) existingSkus.set(lower(row.sku), { variantId: row.variantId, productId: row.productId, baseUnitId: row.baseUnitId });
  }
  const existingBarcodes: ImportLookups["existingBarcodes"] = new Map();
  if (barcodes.length) {
    const rows = await executor.select({ barcode: productUnits.barcode, variantId: productUnits.variantId }).from(productUnits)
      .where(and(eq(productUnits.businessId, businessId), inArray(productUnits.barcode, barcodes)));
    for (const row of rows) if (row.barcode) existingBarcodes.set(row.barcode, row.variantId);
  }
  const unitIdsByName = new Map<string, string>();
  for (const unit of unitRows) {
    unitIdsByName.set(lower(unit.shortName), unit.id);
    unitIdsByName.set(lower(unit.name), unit.id);
  }
  return {
    taxCategoryIdsByName: new Map(taxRows.map((row) => [lower(row.name), row.id])),
    unitIdsByName,
    existingSkus,
    existingBarcodes,
    canSetCost: canSeeCost(principal),
  };
}

export class ImportFileError extends Error {}

export async function analyseImportFile(executor: Executor, principal: Principal, csv: string): Promise<ImportAnalysis> {
  let parsed: ReturnType<typeof csvToRecords>;
  try {
    parsed = csvToRecords(parseCsv(csv));
  } catch (error) {
    throw new ImportFileError(error instanceof Error ? error.message : "The file could not be read as CSV");
  }
  const skus = parsed.records.map((record) => record.sku).filter(Boolean);
  const barcodes = parsed.records.flatMap((record) => [record.barcode, record.alt_barcode]).filter(Boolean);
  return analyseProductImport(parsed.headers, parsed.records, await buildLookups(executor, principal, skus, barcodes));
}

/** Which category paths and brands the import would create, for the preview. */
export async function describeNewReferences(executor: Executor, businessId: string, analysis: ImportAnalysis) {
  const [categoryRows, brandRows] = await Promise.all([
    executor.select().from(categories).where(eq(categories.businessId, businessId)),
    executor.select({ name: brands.name }).from(brands).where(eq(brands.businessId, businessId)),
  ]);
  const known = categoryPathIds(categoryRows);
  const knownBrands = new Set(brandRows.map((brand) => lower(brand.name)));
  return {
    newCategories: analysis.categoryPaths.filter((path) => !known.has(pathKey(path))).map((path) => path.join(" > ")),
    newBrands: analysis.brands.filter((brand) => !knownBrands.has(lower(brand))),
  };
}

function categoryPathIds(rows: Array<{ id: string; parentId: string | null; name: string }>): Map<string, string> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result = new Map<string, string>();
  for (const row of rows) {
    const names: string[] = [];
    for (let cursor: typeof row | undefined = row; cursor; cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined) names.unshift(cursor.name);
    result.set(pathKey(names), row.id);
  }
  return result;
}

const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export type ImportResult = { products: number; variantsCreated: number; variantsUpdated: number; categoriesCreated: number; brandsCreated: number };

/** Writes a clean analysis. Call inside a transaction with an analysis that has no issues. */
export async function commitImport(tx: Executor, principal: Principal, analysis: ImportAnalysis): Promise<ImportResult> {
  const businessId = principal.businessId!;
  const authored = createdByActor(principal);

  // Categories: create missing paths parent-first.
  const categoryRows = await tx.select().from(categories).where(eq(categories.businessId, businessId));
  const categoryIds = categoryPathIds(categoryRows);
  let categoriesCreated = 0;
  for (const path of [...analysis.categoryPaths].sort((a, b) => a.length - b.length)) {
    if (categoryIds.has(pathKey(path))) continue;
    const parentId = path.length > 1 ? categoryIds.get(pathKey(path.slice(0, -1))) ?? null : null;
    const [created] = await tx.insert(categories).values({ businessId, parentId, name: path.at(-1)!, ...authored }).returning({ id: categories.id });
    categoryIds.set(pathKey(path), created.id);
    categoriesCreated += 1;
  }
  const brandRows = await tx.select({ id: brands.id, name: brands.name }).from(brands).where(eq(brands.businessId, businessId));
  const brandIds = new Map(brandRows.map((brand) => [lower(brand.name), brand.id]));
  let brandsCreated = 0;
  for (const brand of analysis.brands) {
    if (brandIds.has(lower(brand))) continue;
    const [created] = await tx.insert(brands).values({ businessId, name: brand, ...authored }).returning({ id: brands.id });
    brandIds.set(lower(brand), created.id);
    brandsCreated += 1;
  }

  const productRows: Array<typeof products.$inferInsert> = [];
  const variantRows: Array<typeof productVariants.$inferInsert> = [];
  const unitRows: Array<typeof productUnits.$inferInsert> = [];
  let variantsUpdated = 0;

  for (const product of analysis.products) {
    const categoryId = product.categoryPath.length ? categoryIds.get(pathKey(product.categoryPath)) ?? null : null;
    const brandId = product.brand ? brandIds.get(lower(product.brand)) ?? null : null;

    if (!product.existingProductId) {
      const productId = randomUUID();
      productRows.push({
        id: productId, businessId, name: product.name, categoryId, brandId, taxCategoryId: product.taxCategoryId,
        hsCode: product.hsCode, baseUnitId: product.baseUnitId, ...authored,
      });
      for (const variant of product.variants) {
        const variantId = randomUUID();
        variantRows.push({
          id: variantId, businessId, productId, sku: variant.sku, variantName: variant.variantName ?? "",
          costPaisa: variant.costPaisa ?? 0, reorderLevel: variant.reorderLevel ?? "0", reorderQuantity: variant.reorderQuantity ?? "0", ...authored,
        });
        for (const unit of variant.units) {
          unitRows.push({
            id: randomUUID(), businessId, variantId, unitId: unit.unitId, factorToBase: unit.factorToBase,
            isBase: unit.unitId === product.baseUnitId, barcode: unit.barcode, salePricePaisa: unit.salePricePaisa ?? 0, ...authored,
          });
        }
      }
      continue;
    }

    const productId = product.existingProductId;
    await tx.update(products).set({
      name: product.name,
      ...(categoryId ? { categoryId } : {}),
      ...(brandId ? { brandId } : {}),
      ...(product.taxCategoryId ? { taxCategoryId: product.taxCategoryId } : {}),
      ...(product.hsCode ? { hsCode: product.hsCode } : {}),
      ...updatedByActor(principal),
    }).where(eq(products.id, productId));

    for (const variant of product.variants) {
      let variantId = variant.existingVariantId;
      if (variantId) {
        variantsUpdated += 1;
        await tx.update(productVariants).set({
          active: true,
          ...(variant.variantName === null ? {} : { variantName: variant.variantName }),
          ...(variant.costPaisa === null ? {} : { costPaisa: variant.costPaisa }),
          ...(variant.reorderLevel === null ? {} : { reorderLevel: variant.reorderLevel }),
          ...(variant.reorderQuantity === null ? {} : { reorderQuantity: variant.reorderQuantity }),
          ...updatedByActor(principal),
        }).where(eq(productVariants.id, variantId));
      } else {
        variantId = randomUUID();
        variantRows.push({
          id: variantId, businessId, productId, sku: variant.sku, variantName: variant.variantName ?? "",
          costPaisa: variant.costPaisa ?? 0, reorderLevel: variant.reorderLevel ?? "0", reorderQuantity: variant.reorderQuantity ?? "0", ...authored,
        });
      }
      for (const unit of variant.units) {
        const row = {
          id: randomUUID(), businessId, variantId, unitId: unit.unitId, factorToBase: unit.factorToBase,
          isBase: unit.unitId === product.baseUnitId, barcode: unit.barcode, salePricePaisa: unit.salePricePaisa ?? 0, ...authored,
        };
        if (!variant.existingVariantId) {
          unitRows.push(row);
          continue;
        }
        // Existing variant: update the units named in the file, keep any others; blank cells keep current values.
        await tx.insert(productUnits).values(row).onConflictDoUpdate({
          target: [productUnits.variantId, productUnits.unitId],
          set: {
            factorToBase: unit.factorToBase,
            ...(unit.barcode === null ? {} : { barcode: unit.barcode }),
            ...(unit.salePricePaisa === null ? {} : { salePricePaisa: unit.salePricePaisa }),
            ...updatedByActor(principal),
          },
        });
      }
    }
  }

  for (const batch of chunks(productRows, 500)) await tx.insert(products).values(batch);
  for (const batch of chunks(variantRows, 500)) await tx.insert(productVariants).values(batch);
  for (const batch of chunks(unitRows, 500)) await tx.insert(productUnits).values(batch);

  return {
    products: analysis.products.length,
    variantsCreated: analysis.variantsToCreate,
    variantsUpdated,
    categoriesCreated,
    brandsCreated,
  };
}
