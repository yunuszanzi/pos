import type { ProductInput } from "../../shared/schemas/catalogue";
import { downloadApiFile, postJson, putJson, requestApi } from "./client";

export type ProductUnit = {
  id: string;
  unitId: string;
  factorToBase: string;
  isBase: boolean;
  barcode: string | null;
  salePricePaisa: number;
  fbrUom: string | null;
};
export type ProductVariant = {
  id: string;
  sku: string;
  variantName: string;
  attributes: Record<string, string>;
  /** Absent when the user lacks products.cost.view. */
  costPaisa?: number;
  reorderLevel: string;
  reorderQuantity: string;
  active: boolean;
  units: ProductUnit[];
};
export type Product = {
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
  variants: ProductVariant[];
};
export type ProductPage = { data: Product[]; page: number; pageSize: number; total: number };
export type ProductListFilter = { q?: string; page?: number; pageSize?: number; active?: "true" | "false" | "all"; categoryId?: string; brandId?: string };

export type ImportIssue = { row: number; field: string; message: string };
export type ImportPreview = {
  canImport: boolean;
  issues: ImportIssue[];
  summary: { products: number; variantsToCreate: number; variantsToUpdate: number; newCategories: string[]; newBrands: string[] };
};
export type ImportResult = { products: number; variantsCreated: number; variantsUpdated: number; categoriesCreated: number; brandsCreated: number };

export function getAllProducts(filter: ProductListFilter = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") query.set(key, String(value));
  return requestApi<ProductPage>(`/products?${query}`, { signal });
}

export function getProductById(id: string) {
  return requestApi<Product>(`/products/${id}`);
}

/** Fallback only: scanning runs against the local catalogue once the POS cache exists (technical-plan 5.7). */
export function getProductByBarcode(barcode: string) {
  return requestApi<{ productId: string; variantId: string; unitId: string; factorToBase: string; product: Product }>(
    `/products/lookup?barcode=${encodeURIComponent(barcode)}`,
  );
}

export function createProduct(input: ProductInput) {
  return postJson<Product>("/products", input);
}

export function updateProduct(id: string, input: ProductInput) {
  return putJson<Product>(`/products/${id}`, input);
}

export function archiveProduct(id: string) {
  return requestApi<{ id: string; active: false }>(`/products/${id}`, { method: "DELETE" });
}

export function previewProductImport(csv: string) {
  return postJson<ImportPreview>("/products/import/preview", { csv });
}

/** The key makes a retry of the same file safe: the server returns the first result instead of importing again. */
export function importProducts(csv: string, idempotencyKey: string) {
  return requestApi<ImportResult>("/products/import", {
    method: "POST",
    body: JSON.stringify({ csv }),
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export function downloadProductsCsv() {
  return downloadApiFile("/products/export", "products.csv");
}
