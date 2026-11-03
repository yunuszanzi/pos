import { parseRupees, type Paisa } from "./money";
import { formatQuantity, parseQuantity } from "./units";

// CSV product import. One row per SKU. Rows sharing a product `name` become variants of one product.
// Importing an existing SKU updates that variant and its product. All-or-nothing: any error blocks the import.

export const importColumns = [
  "sku", "name", "variant_name", "category", "brand", "tax_category", "hs_code", "base_unit",
  "sale_price", "cost", "barcode", "reorder_level", "reorder_quantity",
  "alt_unit", "alt_factor", "alt_barcode", "alt_price",
] as const;
const requiredColumns = ["sku", "name"] as const;
export const maxImportRows = 5000;

export type ImportIssue = { row: number; field: string; message: string };

export type ImportLookups = {
  taxCategoryIdsByName: Map<string, string>;
  unitIdsByName: Map<string, string>;
  /** lower-case SKU -> existing variant */
  existingSkus: Map<string, { variantId: string; productId: string }>;
  /** barcode -> variant that owns it */
  existingBarcodes: Map<string, string>;
};

export type ImportUnit = { unitId: string; factorToBase: string; barcode: string | null; salePricePaisa: Paisa };
export type ImportVariant = {
  row: number;
  existingVariantId: string | null;
  sku: string;
  variantName: string;
  costPaisa: Paisa;
  reorderLevel: string;
  reorderQuantity: string;
  units: ImportUnit[];
};
export type ImportProduct = {
  existingProductId: string | null;
  name: string;
  categoryPath: string[];
  brand: string | null;
  taxCategoryId: string | null;
  hsCode: string | null;
  baseUnitId: string;
  variants: ImportVariant[];
};
export type ImportAnalysis = {
  issues: ImportIssue[];
  products: ImportProduct[];
  variantsToCreate: number;
  variantsToUpdate: number;
  categoryPaths: string[][];
  brands: string[];
};

const key = (text: string) => text.trim().toLowerCase();
const barcodePattern = /^[\x21-\x7E]{1,64}$/;
const hsCodePattern = /^[0-9.]{4,12}$/;

export function analyseProductImport(
  headers: string[],
  records: Array<Record<string, string>>,
  lookups: ImportLookups,
): ImportAnalysis {
  const issues: ImportIssue[] = [];
  const fileIssue = (field: string, message: string) => issues.push({ row: 1, field, message });

  for (const column of requiredColumns) {
    if (!headers.includes(column)) fileIssue(column, `The "${column}" column is required`);
  }
  for (const header of headers) {
    if (header && !(importColumns as readonly string[]).includes(header)) {
      fileIssue(header, `Unknown column "${header}". Expected: ${importColumns.join(", ")}`);
    }
  }
  if (!records.length) fileIssue("file", "The file has a header but no product rows");
  if (records.length > maxImportRows) {
    fileIssue("file", `At most ${maxImportRows} rows can be imported at once; this file has ${records.length}`);
  }
  if (issues.length) return { issues, products: [], variantsToCreate: 0, variantsToUpdate: 0, categoryPaths: [], brands: [] };

  const groups = new Map<string, ImportProduct>();
  const seenSkus = new Map<string, number>();
  const seenBarcodes = new Map<string, number>();

  records.forEach((record, index) => {
    const row = index + 2;
    const problem = (field: string, message: string) => issues.push({ row, field, message });
    const parse = <T>(field: string, run: () => T, fallback: T): T => {
      try {
        return run();
      } catch {
        problem(field, `"${record[field]}" is not a valid ${field.replace(/_/g, " ")}`);
        return fallback;
      }
    };
    const get = (field: string) => record[field] ?? "";

    const sku = get("sku");
    const name = get("name");
    if (!sku) problem("sku", "SKU is required");
    if (sku.length > 64) problem("sku", "SKU is longer than 64 characters");
    if (!name) problem("name", "Product name is required");
    if (name.length > 200) problem("name", "Product name is longer than 200 characters");
    if (sku) {
      const firstSeen = seenSkus.get(key(sku));
      if (firstSeen) problem("sku", `SKU "${sku}" already appears on row ${firstSeen}`);
      else seenSkus.set(key(sku), row);
    }

    const baseUnitName = get("base_unit") || "Piece";
    const baseUnitId = lookups.unitIdsByName.get(key(baseUnitName));
    if (!baseUnitId) problem("base_unit", `Unknown unit "${baseUnitName}"`);
    const taxName = get("tax_category");
    const taxCategoryId = taxName ? lookups.taxCategoryIdsByName.get(key(taxName)) ?? null : null;
    if (taxName && !taxCategoryId) problem("tax_category", `Unknown tax category "${taxName}"`);
    const hsCode = get("hs_code") || null;
    if (hsCode && !hsCodePattern.test(hsCode)) problem("hs_code", `HS code "${hsCode}" should use digits and dots, e.g. 9503.0090`);

    const salePrice = get("sale_price") ? parse("sale_price", () => parseRupees(get("sale_price")), 0) : 0;
    const cost = get("cost") ? parse("cost", () => parseRupees(get("cost")), 0) : 0;
    if (salePrice < 0) problem("sale_price", "Sale price cannot be negative");
    if (cost < 0) problem("cost", "Cost cannot be negative");
    const reorderLevel = get("reorder_level") ? parse("reorder_level", () => formatQuantity(parseQuantity(get("reorder_level"))), "0") : "0";
    const reorderQuantity = get("reorder_quantity") ? parse("reorder_quantity", () => formatQuantity(parseQuantity(get("reorder_quantity"))), "0") : "0";

    const barcode = get("barcode") || null;
    if (barcode && !barcodePattern.test(barcode)) problem("barcode", `Barcode "${barcode}" must have no spaces and at most 64 characters`);

    const units: ImportUnit[] = [];
    if (baseUnitId) units.push({ unitId: baseUnitId, factorToBase: "1", barcode, salePricePaisa: Math.max(0, salePrice) });
    const altUnitName = get("alt_unit");
    if (altUnitName) {
      const altUnitId = lookups.unitIdsByName.get(key(altUnitName));
      if (!altUnitId) problem("alt_unit", `Unknown unit "${altUnitName}"`);
      if (altUnitId && altUnitId === baseUnitId) problem("alt_unit", "The alternative unit must differ from the base unit");
      const factor = get("alt_factor")
        ? parse("alt_factor", () => formatQuantity(parseQuantity(get("alt_factor"))), "0")
        : "0";
      if (!get("alt_factor")) problem("alt_factor", "Give the number of base units in one alternative unit, e.g. 200");
      else if (parseQuantity(factor) <= 0) problem("alt_factor", "The factor must be greater than zero");
      const altBarcode = get("alt_barcode") || null;
      if (altBarcode && !barcodePattern.test(altBarcode)) problem("alt_barcode", `Barcode "${altBarcode}" must have no spaces and at most 64 characters`);
      const altPrice = get("alt_price") ? parse("alt_price", () => parseRupees(get("alt_price")), 0) : 0;
      if (altPrice < 0) problem("alt_price", "Price cannot be negative");
      if (altUnitId && altUnitId !== baseUnitId && parseQuantity(factor) > 0) {
        units.push({ unitId: altUnitId, factorToBase: factor, barcode: altBarcode, salePricePaisa: Math.max(0, altPrice) });
      }
    }

    const existing = sku ? lookups.existingSkus.get(key(sku)) ?? null : null;
    for (const unit of units) {
      if (!unit.barcode) continue;
      const firstSeen = seenBarcodes.get(unit.barcode);
      if (firstSeen) problem("barcode", `Barcode ${unit.barcode} already appears on row ${firstSeen}`);
      else seenBarcodes.set(unit.barcode, row);
      const owner = lookups.existingBarcodes.get(unit.barcode);
      if (owner && owner !== existing?.variantId) problem("barcode", `Barcode ${unit.barcode} already belongs to another product`);
    }

    if (!name) return;
    const categoryPath = get("category").split(">").map((part) => part.trim()).filter(Boolean);
    const brand = get("brand") || null;
    const variant: ImportVariant = {
      row,
      existingVariantId: existing?.variantId ?? null,
      sku,
      variantName: get("variant_name"),
      costPaisa: Math.max(0, cost),
      reorderLevel,
      reorderQuantity,
      units,
    };
    const group = groups.get(key(name));
    if (!group) {
      groups.set(key(name), {
        existingProductId: existing?.productId ?? null,
        name,
        categoryPath,
        brand,
        taxCategoryId,
        hsCode,
        baseUnitId: baseUnitId ?? "",
        variants: [variant],
      });
      return;
    }
    const same = (field: string, a: unknown, b: unknown) => {
      if (JSON.stringify(a) !== JSON.stringify(b)) problem(field, `Rows for "${name}" must agree on ${field.replace(/_/g, " ")} (row ${group.variants[0].row} differs)`);
    };
    same("category", group.categoryPath, categoryPath);
    same("brand", group.brand, brand);
    same("tax_category", group.taxCategoryId, taxCategoryId);
    same("hs_code", group.hsCode, hsCode);
    if (baseUnitId) same("base_unit", group.baseUnitId, baseUnitId);
    if (existing) {
      if (group.existingProductId && group.existingProductId !== existing.productId) {
        problem("sku", `SKUs of "${name}" belong to different existing products`);
      }
      group.existingProductId ??= existing.productId;
    }
    group.variants.push(variant);
  });

  const products = [...groups.values()];
  const variants = products.flatMap((product) => product.variants);
  const categoryPaths = new Map<string, string[]>();
  for (const product of products) {
    for (let depth = 1; depth <= product.categoryPath.length; depth += 1) {
      const path = product.categoryPath.slice(0, depth);
      categoryPaths.set(path.map(key).join(">"), path);
    }
  }
  const brands = new Map<string, string>();
  for (const product of products) if (product.brand) brands.set(key(product.brand), product.brand);

  return {
    issues,
    products,
    variantsToCreate: variants.filter((variant) => !variant.existingVariantId).length,
    variantsToUpdate: variants.filter((variant) => variant.existingVariantId).length,
    categoryPaths: [...categoryPaths.values()],
    brands: [...brands.values()],
  };
}

export const importTemplateCsvRows: string[][] = [
  [...importColumns],
  ["BAL-12-RED", "Latex Balloon 12 inch", "Red", "Balloons > Latex", "Party Co", "Standard rate 18%", "9503.0090", "Piece", "5.00", "3.20", "8964000000017", "500", "2000", "Carton", "1000", "8964000000024", "4500.00"],
  ["BAL-12-BLU", "Latex Balloon 12 inch", "Blue", "Balloons > Latex", "Party Co", "Standard rate 18%", "9503.0090", "Piece", "5.00", "3.20", "", "500", "2000", "", "", "", ""],
];
