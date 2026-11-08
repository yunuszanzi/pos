import type { SupplierInput } from "../../shared/schemas/suppliers";
import { deleteJson, postJson, putJson, requestApi } from "./client";
import type { ImportIssue } from "./productsApi";

export type Supplier = {
  id: string;
  name: string;
  contactPerson: string;
  phone: string;
  whatsapp: string;
  email: string;
  address: string;
  ntn: string | null;
  strn: string | null;
  registered: boolean;
  termsDays: number;
  notes: string;
  active: boolean;
  /** What the shop owes them (negative: they owe the shop). Only for people who may see the ledger. */
  balancePaisa?: number;
};
export type SupplierPage = { data: Supplier[]; page: number; pageSize: number; total: number };
export type SupplierFilter = { q?: string; active?: "true" | "false" | "all"; page?: number; pageSize?: number };

export type SupplierLedgerEntry = {
  id: string; docType: string; docId: string; docNumber: string; memo: string; debitPaisa: number; creditPaisa: number; at: string; balanceAfterPaisa: number;
};
export type SupplierLedger = {
  supplier: { id: string; name: string; phone: string; whatsapp: string; termsDays: number; balancePaisa: number };
  entries: SupplierLedgerEntry[];
  page: number; pageSize: number; total: number;
};
export type SupplierAgeingRow = {
  supplierId: string; name: string; phone: string; whatsapp: string; termsDays: number; balancePaisa: number;
  bandsPaisa: [number, number, number, number]; owedPaisa: number; creditPaisa: number; oldestDays: number; overdue: boolean;
};
export type SupplierAgeingReport = { data: SupplierAgeingRow[]; totals: { bandsPaisa: [number, number, number, number]; owedPaisa: number }; page: number; pageSize: number; total: number };
export type PayablesPreview = { canImport: boolean; issues: ImportIssue[]; summary: { suppliers: number; owedPaisa: number; creditPaisa: number } };
export type PayablesResult = { suppliers: number; owedPaisa: number; creditPaisa: number };

export function getAllSuppliers(filter: SupplierFilter = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") query.set(key, String(value));
  return requestApi<SupplierPage>(`/suppliers?${query}`, { signal });
}
export const getSupplierById = (id: string) => requestApi<Supplier>(`/suppliers/${id}`);
export const createSupplier = (input: SupplierInput) => postJson<Supplier>("/suppliers", input);
export const updateSupplier = (id: string, input: SupplierInput) => putJson<Supplier>(`/suppliers/${id}`, input);
export const archiveSupplier = (id: string) => deleteJson<{ id: string; active: false }>(`/suppliers/${id}`);

export const getSupplierLedger = (id: string, page = 1, signal?: AbortSignal) => requestApi<SupplierLedger>(`/suppliers/${id}/ledger?page=${page}`, { signal });
export function getSupplierAgeing(filter: { q?: string; overdue?: boolean; page?: number; pageSize?: number } = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "" && value !== false) query.set(key, String(value));
  return requestApi<SupplierAgeingReport>(`/supplier-ageing?${query}`, { signal });
}
export const previewOpeningPayables = (csv: string) => postJson<PayablesPreview>("/suppliers-opening-balances/preview", { csv });
export const importOpeningPayables = (csv: string, idempotencyKey: string) =>
  postJson<PayablesResult>("/suppliers-opening-balances", { csv }, { "Idempotency-Key": idempotencyKey });
