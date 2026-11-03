import { postJson, putJson, requestApi } from "./client";

export type Category = { id: string; parentId: string | null; name: string; active: boolean };
export type Brand = { id: string; name: string; active: boolean };
export type TaxKind = "standard" | "reduced" | "zero_rated" | "exempt" | "third_schedule";
export type TaxCategory = { id: string; name: string; kind: TaxKind; rateBps: number; fbrSaleType: string | null; active: boolean };
export type Unit = { id: string; name: string; shortName: string; active: boolean };

export function getAllCategories() {
  return requestApi<Category[]>("/categories");
}
export function createCategory(input: { name: string; parentId: string | null }) {
  return postJson<Category>("/categories", input);
}
export function updateCategory(id: string, input: Partial<{ name: string; parentId: string | null; active: boolean }>) {
  return putJson<Category>(`/categories/${id}`, input);
}

export function getAllBrands() {
  return requestApi<Brand[]>("/brands");
}
export function createBrand(input: { name: string }) {
  return postJson<Brand>("/brands", input);
}
export function updateBrand(id: string, input: Partial<{ name: string; active: boolean }>) {
  return putJson<Brand>(`/brands/${id}`, input);
}

export function getAllTaxCategories() {
  return requestApi<TaxCategory[]>("/tax-categories");
}
export function updateTaxCategory(id: string, input: Partial<{ name: string; rateBps: number; fbrSaleType: string | null; active: boolean }>) {
  return putJson<TaxCategory>(`/tax-categories/${id}`, input);
}

export function getAllUnits() {
  return requestApi<Unit[]>("/units");
}
export function createUnit(input: { name: string; shortName: string }) {
  return postJson<Unit>("/units", input);
}
export function updateUnit(id: string, input: Partial<{ name: string; shortName: string; active: boolean }>) {
  return putJson<Unit>(`/units/${id}`, input);
}
