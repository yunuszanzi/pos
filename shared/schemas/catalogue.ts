import { z } from "zod";
import { parseQuantity } from "../units";

const name = z.string().trim().min(1).max(200);
const uuid = z.string().uuid();

/** numeric(14,3) as a string: "200", "0.5", "12.345". */
export const quantitySchema = z.string().trim().regex(/^\d{1,11}(\.\d{1,3})?$/, "Use a number with up to 3 decimals");
const positiveQuantity = quantitySchema.refine((value) => parseQuantity(value) > 0, "Must be greater than zero");

const paisa = z.number().int().min(0).max(100_000_000_000);
const barcode = z.string().trim().regex(/^[\x21-\x7E]{1,64}$/, "Barcode has no spaces and at most 64 characters");
const hsCode = z.string().trim().regex(/^[0-9.]{4,12}$/, "HS code uses digits and dots, e.g. 9503.0090");

export const categorySchema = z.object({
  name,
  parentId: uuid.nullable().default(null),
  active: z.boolean().optional(),
});

export const brandSchema = z.object({ name, active: z.boolean().optional() });

export const taxCategorySchema = z.object({
  name,
  kind: z.enum(["standard", "reduced", "zero_rated", "exempt", "third_schedule"]),
  rateBps: z.number().int().min(0).max(10000),
  fbrSaleType: z.string().trim().max(120).nullable().default(null),
  active: z.boolean().optional(),
});

export const unitSchema = z.object({
  name: z.string().trim().min(1).max(60),
  shortName: z.string().trim().min(1).max(12),
  active: z.boolean().optional(),
});

export const productUnitSchema = z.object({
  unitId: uuid,
  factorToBase: positiveQuantity,
  barcode: barcode.nullable().default(null),
  salePricePaisa: paisa,
  fbrUom: z.string().trim().max(80).nullable().default(null),
});

export const variantSchema = z.object({
  id: uuid.optional(),
  sku: z.string().trim().min(1).max(64),
  variantName: z.string().trim().max(200).default(""),
  attributes: z.record(z.string().trim().min(1).max(60), z.string().trim().max(120)).default({}),
  costPaisa: paisa.default(0),
  reorderLevel: quantitySchema.default("0"),
  reorderQuantity: quantitySchema.default("0"),
  units: z.array(productUnitSchema).min(1).max(12),
});

export const productSchema = z.object({
  name,
  description: z.string().trim().max(2000).default(""),
  categoryId: uuid.nullable().default(null),
  brandId: uuid.nullable().default(null),
  taxCategoryId: uuid.nullable().default(null),
  hsCode: hsCode.nullable().default(null),
  imageUrl: z.string().url().max(500).nullable().default(null),
  productType: z.enum(["stocked", "non_stock", "service"]).default("stocked"),
  baseUnitId: uuid,
  variants: z.array(variantSchema).min(1).max(200),
}).superRefine((product, context) => {
  const skus = new Set<string>();
  const barcodes = new Set<string>();
  product.variants.forEach((variant, variantIndex) => {
    const sku = variant.sku.toLowerCase();
    if (skus.has(sku)) context.addIssue({ code: "custom", path: ["variants", variantIndex, "sku"], message: `SKU "${variant.sku}" is used twice` });
    skus.add(sku);

    const unitIds = new Set<string>();
    const base = variant.units.filter((unit) => unit.unitId === product.baseUnitId);
    if (base.length !== 1 || parseQuantity(base[0].factorToBase) !== 1000) {
      context.addIssue({ code: "custom", path: ["variants", variantIndex, "units"], message: "Include the base unit exactly once, with factor 1" });
    }
    variant.units.forEach((unit, unitIndex) => {
      if (unitIds.has(unit.unitId)) context.addIssue({ code: "custom", path: ["variants", variantIndex, "units", unitIndex, "unitId"], message: "Each unit can appear once per variant" });
      unitIds.add(unit.unitId);
      if (unit.barcode) {
        if (barcodes.has(unit.barcode)) context.addIssue({ code: "custom", path: ["variants", variantIndex, "units", unitIndex, "barcode"], message: `Barcode ${unit.barcode} is used twice` });
        barcodes.add(unit.barcode);
      }
    });
  });
});

export const priceListSchema = z.object({
  name,
  active: z.boolean().optional(),
  items: z.array(z.object({
    variantId: uuid,
    unitId: uuid,
    minQuantity: positiveQuantity.default("1"),
    pricePaisa: paisa,
  })).max(5000).default([]),
}).superRefine((list, context) => {
  const seen = new Set<string>();
  list.items.forEach((item, index) => {
    const key = `${item.variantId}|${item.unitId}|${parseQuantity(item.minQuantity)}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["items", index], message: "Duplicate price for the same product, unit and minimum quantity" });
    seen.add(key);
  });
});

export type ProductInput = z.input<typeof productSchema>;
export type ProductData = z.output<typeof productSchema>;
