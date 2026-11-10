import { and, eq, inArray, sql } from "drizzle-orm";
import { brands, categories, productUnits, productVariants, products, stockLedger, taxCategories, units } from "../../../db/schema";
import type { ProductData } from "../../../shared/schemas/catalogue";
import { formatQuantity, parseQuantity, parseSignedQuantity } from "../../../shared/units";
import { db } from "../../lib/db";
import { createdByActor, hasPermission, updatedByActor, type Principal } from "../../lib/permissions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ProductUnitView = {
  id: string;
  unitId: string;
  factorToBase: string;
  isBase: boolean;
  barcode: string | null;
  salePricePaisa: number;
  fbrUom: string | null;
};
export type ProductVariantView = {
  id: string;
  sku: string;
  variantName: string;
  attributes: Record<string, string>;
  /** Left out for users without products.cost.view. */
  costPaisa?: number;
  reorderLevel: string;
  reorderQuantity: string;
  active: boolean;
  units: ProductUnitView[];
};
export type ProductView = {
  id: string;
  name: string;
  description: string;
  categoryId: string | null;
  brandId: string | null;
  taxCategoryId: string | null;
  hsCode: string | null;
  imageUrl: string | null;
  productType: "stocked" | "non_stock" | "service";
  baseUnitId: string;
  active: boolean;
  variants: ProductVariantView[];
};

export const canSeeCost = (principal: Principal) => hasPermission(principal, "products.cost.view");

/** numeric(14,3) comes back as "200.000" (or "-5.000" when stock is negative); show it as "200" / "-5". */
export const quantityText = (value: string) => formatQuantity(parseSignedQuantity(value));

export async function loadProductViews(businessId: string, productIds: string[], withCost: boolean): Promise<ProductView[]> {
  if (!productIds.length) return [];
  const [productRows, variantRows] = await Promise.all([
    db.select().from(products).where(and(eq(products.businessId, businessId), inArray(products.id, productIds))),
    db.select().from(productVariants).where(and(eq(productVariants.businessId, businessId), inArray(productVariants.productId, productIds))).orderBy(productVariants.sku),
  ]);
  const unitRows = variantRows.length
    ? await db.select().from(productUnits).where(and(eq(productUnits.businessId, businessId), inArray(productUnits.variantId, variantRows.map((variant) => variant.id))))
    : [];

  const unitsByVariant = new Map<string, ProductUnitView[]>();
  for (const unit of unitRows) {
    const list = unitsByVariant.get(unit.variantId) ?? [];
    list.push({
      id: unit.id,
      unitId: unit.unitId,
      factorToBase: quantityText(unit.factorToBase),
      isBase: unit.isBase,
      barcode: unit.barcode,
      salePricePaisa: unit.salePricePaisa,
      fbrUom: unit.fbrUom,
    });
    unitsByVariant.set(unit.variantId, list);
  }
  const variantsByProduct = new Map<string, ProductVariantView[]>();
  for (const variant of variantRows) {
    const list = variantsByProduct.get(variant.productId) ?? [];
    list.push({
      id: variant.id,
      sku: variant.sku,
      variantName: variant.variantName,
      attributes: variant.attributes,
      ...(withCost ? { costPaisa: variant.costPaisa } : {}),
      reorderLevel: quantityText(variant.reorderLevel),
      reorderQuantity: quantityText(variant.reorderQuantity),
      active: variant.active,
      units: (unitsByVariant.get(variant.id) ?? []).sort((a, b) => Number(b.isBase) - Number(a.isBase) || parseQuantity(a.factorToBase) - parseQuantity(b.factorToBase)),
    });
    variantsByProduct.set(variant.productId, list);
  }
  const byId = new Map(productRows.map((product) => [product.id, product]));
  return productIds.flatMap((id) => {
    const product = byId.get(id);
    if (!product) return [];
    return [{
      id: product.id,
      name: product.name,
      description: product.description,
      categoryId: product.categoryId,
      brandId: product.brandId,
      taxCategoryId: product.taxCategoryId,
      hsCode: product.hsCode,
      imageUrl: product.imageUrl,
      productType: product.productType,
      baseUnitId: product.baseUnitId,
      active: product.active,
      variants: variantsByProduct.get(id) ?? [],
    }];
  });
}

/** Returns a message if any referenced category, brand, tax category or unit is not in this business. */
export async function findReferenceProblem(businessId: string, input: ProductData): Promise<string | null> {
  const check = async (label: string, ids: string[], table: typeof categories | typeof brands | typeof taxCategories | typeof units) => {
    const unique = [...new Set(ids)];
    if (!unique.length) return null;
    const found = await db.select({ id: table.id }).from(table).where(and(eq(table.businessId, businessId), inArray(table.id, unique)));
    return found.length === unique.length ? null : `Choose a ${label} from this business`;
  };
  return await check("category", input.categoryId ? [input.categoryId] : [], categories)
    ?? await check("brand", input.brandId ? [input.brandId] : [], brands)
    ?? await check("tax category", input.taxCategoryId ? [input.taxCategoryId] : [], taxCategories)
    ?? await check("unit", [input.baseUnitId, ...input.variants.flatMap((variant) => variant.units.map((unit) => unit.unitId))], units);
}

export class ProductRuleError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

export async function createProduct(tx: Tx, principal: Principal, input: ProductData): Promise<string> {
  const businessId = principal.businessId!;
  const withCost = canSeeCost(principal);
  const { variants, active, ...fields } = input;
  void active; // a new product is always active
  const [product] = await tx.insert(products).values({ ...fields, businessId, ...createdByActor(principal) }).returning({ id: products.id });
  for (const variant of variants) {
    const { units: variantUnits, costPaisa, ...variantFields } = variant;
    const [created] = await tx.insert(productVariants).values({
      ...variantFields,
      id: undefined,
      productId: product.id,
      businessId,
      costPaisa: withCost ? costPaisa : 0,
      ...createdByActor(principal),
    }).returning({ id: productVariants.id });
    await tx.insert(productUnits).values(variantUnits.map((unit) => ({
      ...unit,
      variantId: created.id,
      businessId,
      isBase: unit.unitId === input.baseUnitId,
      ...createdByActor(principal),
    })));
  }
  return product.id;
}

export async function updateProduct(tx: Tx, principal: Principal, productId: string, input: ProductData): Promise<void> {
  const businessId = principal.businessId!;
  const withCost = canSeeCost(principal);
  const [current] = await tx.select().from(products).where(and(eq(products.id, productId), eq(products.businessId, businessId))).limit(1);
  if (!current) throw new ProductRuleError("NOT_FOUND", "Product not found", 404);
  const existingVariants = await tx.select().from(productVariants).where(eq(productVariants.productId, productId));

  if (current.baseUnitId !== input.baseUnitId && existingVariants.length) {
    const [moved] = await tx.select({ id: stockLedger.id }).from(stockLedger)
      .where(inArray(stockLedger.variantId, existingVariants.map((variant) => variant.id))).limit(1);
    if (moved) throw new ProductRuleError("BASE_UNIT_LOCKED", "The base unit cannot change once the product has stock movements", 409);
  }

  const { variants, active, ...fields } = input;
  await tx.update(products).set({ ...fields, ...(active === undefined ? {} : { active }), ...updatedByActor(principal) }).where(eq(products.id, productId));

  const existingIds = new Set(existingVariants.map((variant) => variant.id));
  const keptIds = new Set<string>();
  for (const variant of variants) {
    const { units: variantUnits, costPaisa, id, ...variantFields } = variant;
    let variantId = id;
    if (id) {
      if (!existingIds.has(id)) throw new ProductRuleError("INVALID_VARIANT", "A variant does not belong to this product");
      await tx.update(productVariants).set({
        ...variantFields,
        ...(withCost ? { costPaisa } : {}),
        active: true,
        ...updatedByActor(principal),
      }).where(eq(productVariants.id, id));
    } else {
      const [created] = await tx.insert(productVariants).values({
        ...variantFields, productId, businessId, costPaisa: withCost ? costPaisa : 0, ...createdByActor(principal),
      }).returning({ id: productVariants.id });
      variantId = created.id;
    }
    keptIds.add(variantId!);

    const wanted = new Set(variantUnits.map((unit) => unit.unitId));
    const currentUnits = await tx.select().from(productUnits).where(eq(productUnits.variantId, variantId!));
    const dropped = currentUnits.filter((unit) => !wanted.has(unit.unitId)).map((unit) => unit.id);
    if (dropped.length) await tx.delete(productUnits).where(inArray(productUnits.id, dropped));
    // Clear base flags first so the one-base-unit-per-variant index never sees two at once.
    await tx.update(productUnits).set({ isBase: false }).where(eq(productUnits.variantId, variantId!));
    for (const unit of variantUnits) {
      const values = { ...unit, variantId: variantId!, businessId, isBase: unit.unitId === input.baseUnitId };
      await tx.insert(productUnits).values({ ...values, ...createdByActor(principal) }).onConflictDoUpdate({
        target: [productUnits.variantId, productUnits.unitId],
        set: { factorToBase: unit.factorToBase, isBase: values.isBase, barcode: unit.barcode, salePricePaisa: unit.salePricePaisa, fbrUom: unit.fbrUom, ...updatedByActor(principal) },
      });
    }
  }

  const removed = existingVariants.filter((variant) => !keptIds.has(variant.id)).map((variant) => variant.id);
  if (removed.length) {
    await tx.update(productVariants).set({ active: false, ...updatedByActor(principal) }).where(inArray(productVariants.id, removed));
  }
}

/** Soft delete: the product and all its variants stop appearing in sales and lookups; history stays. */
export async function archiveProduct(tx: Tx, principal: Principal, productId: string): Promise<boolean> {
  const archived = await tx.update(products).set({ active: false, ...updatedByActor(principal) })
    .where(and(eq(products.id, productId), eq(products.businessId, principal.businessId!))).returning({ id: products.id });
  if (!archived.length) return false;
  await tx.update(productVariants).set({ active: false, ...updatedByActor(principal) }).where(eq(productVariants.productId, productId));
  return true;
}

export const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);
export const matchesProductText = (businessId: string, pattern: string) => sql`(
  ${products.name} ilike ${pattern}
  or exists (select 1 from product_variants v where v.product_id = ${products.id} and v.business_id = ${businessId} and v.sku ilike ${pattern})
  or exists (select 1 from product_variants v join product_units pu on pu.variant_id = v.id
             where v.product_id = ${products.id} and v.business_id = ${businessId} and pu.barcode ilike ${pattern})
)`;
