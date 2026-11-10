import type { Product } from "../api/productsApi";
import { parseQuantity, type Milli } from "../../shared/units";

/** One thing the till can sell: a SKU in one unit, with the price and tax rate it sells at. */
export type CatalogueEntry = {
  productId: string;
  variantId: string;
  unitId: string;
  productName: string;
  variantName: string;
  sku: string;
  unitName: string;
  barcode: string | null;
  factorToBaseMilli: Milli;
  isBaseUnit: boolean;
  pricePaisa: number;
  taxRateBps: number;
  productType: Product["productType"];
  categoryId: string | null;
  searchText: string;
};

export type CatalogueReference = {
  units: Array<{ id: string; name: string }>;
  taxCategories: Array<{ id: string; rateBps: number }>;
};

/** The local catalogue: barcode scans, search and price lookups answer from here without calling the server (technical-plan 5.7). */
export class CatalogueIndex {
  private readonly entries: CatalogueEntry[] = [];
  private readonly barcodes = new Map<string, CatalogueEntry>();
  private readonly skus = new Map<string, CatalogueEntry[]>();
  private readonly pairs = new Map<string, CatalogueEntry>();

  constructor(products: Iterable<Product>, reference: CatalogueReference) {
    const unitName = new Map(reference.units.map((unit) => [unit.id, unit.name]));
    const taxRate = new Map(reference.taxCategories.map((tax) => [tax.id, tax.rateBps]));
    for (const product of products) {
      if (!product.active) continue;
      for (const variant of product.variants) {
        if (!variant.active) continue;
        for (const unit of variant.units) {
          const entry: CatalogueEntry = {
            productId: product.id,
            variantId: variant.id,
            unitId: unit.unitId,
            productName: product.name,
            variantName: variant.variantName,
            sku: variant.sku,
            unitName: unitName.get(unit.unitId) ?? "",
            barcode: unit.barcode,
            factorToBaseMilli: parseQuantity(unit.factorToBase),
            isBaseUnit: unit.isBase,
            pricePaisa: unit.salePricePaisa,
            taxRateBps: product.taxCategoryId ? taxRate.get(product.taxCategoryId) ?? 0 : 0,
            productType: product.productType,
            categoryId: product.categoryId,
            searchText: [product.name, variant.variantName, variant.sku, unit.barcode ?? ""].join(" ").toLowerCase(),
          };
          this.entries.push(entry);
          if (unit.barcode) this.barcodes.set(unit.barcode, entry);
          this.skus.set(variant.sku.toLowerCase(), [...(this.skus.get(variant.sku.toLowerCase()) ?? []), entry]);
          this.pairs.set(`${variant.id}|${unit.unitId}`, entry);
        }
      }
    }
    this.entries.sort((a, b) => a.productName.localeCompare(b.productName) || a.sku.localeCompare(b.sku) || a.factorToBaseMilli - b.factorToBaseMilli);
  }

  get size() {
    return this.entries.length;
  }

  all(): readonly CatalogueEntry[] {
    return this.entries;
  }

  /** An exact barcode scan. */
  findByBarcode(code: string): CatalogueEntry | undefined {
    return this.barcodes.get(code.trim());
  }

  get(variantId: string, unitId: string): CatalogueEntry | undefined {
    return this.pairs.get(`${variantId}|${unitId}`);
  }

  /** Every unit a SKU is sold in, smallest first. */
  unitsOf(variantId: string): CatalogueEntry[] {
    return this.entries.filter((entry) => entry.variantId === variantId);
  }

  /**
   * What the cashier typed: an exact barcode or SKU first (a typed barcode must behave like a scan), then names that start with
   * the words, then names that contain all of them.
   */
  search(text: string, limit = 50): CatalogueEntry[] {
    const query = text.trim().toLowerCase();
    if (!query) return [];
    const exactBarcode = this.barcodes.get(text.trim());
    if (exactBarcode) return [exactBarcode];
    const exactSku = this.skus.get(query);
    if (exactSku) return exactSku.slice(0, limit);
    const words = query.split(/\s+/);
    const starts: CatalogueEntry[] = [];
    const contains: CatalogueEntry[] = [];
    for (const entry of this.entries) {
      if (!words.every((word) => entry.searchText.includes(word))) continue;
      (entry.searchText.startsWith(words[0]) ? starts : contains).push(entry);
      if (starts.length >= limit) break;
    }
    return [...starts, ...contains].slice(0, limit);
  }
}
