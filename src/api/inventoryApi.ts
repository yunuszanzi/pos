import type { StockAdjustmentInput } from "../../shared/schemas/inventory";
import { postJson, requestApi } from "./client";
import type { ImportIssue } from "./productsApi";

export type StockLevel = {
  variantId: string;
  sku: string;
  variantName: string;
  productId: string;
  productName: string;
  baseUnitId: string;
  onHand: string;
  reserved: string;
  available: string;
  reorderLevel: string;
  low: boolean;
  units: Array<{ unitId: string; factorToBase: string; isBase: boolean }>;
  /** Absent when the user lacks products.cost.view. */
  avgCostPaisa?: number;
  valuePaisa?: number;
};
export type StockLevelFilter = { q?: string; locationId?: string; low?: boolean; page?: number; pageSize?: number };

export type LedgerEntry = {
  id: string;
  createdAt: string;
  locationId: string;
  locationName: string;
  quantity: string;
  balanceAfter: string;
  docType: string;
  docId: string;
  createdByName: string | null;
  unitCostPaisa?: number;
};
export type StockLedger = {
  variant: { sku: string; variantName: string; productName: string; baseUnitId: string };
  data: LedgerEntry[];
  page: number;
  pageSize: number;
  total: number;
};
export type LedgerFilter = { variantId: string; locationId?: string; from?: string; to?: string; page?: number; pageSize?: number };

export type AdjustmentStatus = "pending" | "approved" | "rejected";
export type AdjustmentSummary = {
  id: string;
  reason: string;
  status: AdjustmentStatus;
  note: string;
  createdAt: string;
  locationName: string;
  createdByName: string | null;
  lineCount: number;
  totalValuePaisa?: number;
};
export type Adjustment = {
  id: string;
  locationId: string;
  locationName: string;
  reason: string;
  note: string;
  status: AdjustmentStatus;
  totalValuePaisa?: number;
  createdAt: string;
  createdByName: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  lines: Array<{ variantId: string; sku: string; productName: string; variantName: string; unitId: string; qtyEntered: string; qtyBaseDelta: string; unitCostPaisa?: number }>;
};

export type Valuation = {
  asOf: string | null;
  salePriceBasis: "current";
  rows: Array<{ variantId: string; sku: string; productName: string; variantName: string; baseUnitId: string; onHand: string; costValuePaisa: number; salePricePaisa: number; saleValuePaisa: number }>;
  totals: { costValuePaisa: number; saleValuePaisa: number };
};

export type OpeningStockPreview = { canImport: boolean; issues: ImportIssue[]; summary: { lines: number; locations: number } };
export type OpeningStockResult = { locations: number; lines: number; adjustmentIds: string[]; valuePaisa?: number };

function query(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "" && value !== false) search.set(key, String(value));
  return search.toString();
}

export function getStockLevels(filter: StockLevelFilter = {}, signal?: AbortSignal) {
  return requestApi<{ data: StockLevel[]; page: number; pageSize: number; total: number }>(`/stock?${query({ ...filter })}`, { signal });
}

export function getStockLedger(filter: LedgerFilter) {
  return requestApi<StockLedger>(`/stock/ledger?${query({ ...filter })}`);
}

export function getStockValuation(filter: { asOf?: string; locationId?: string } = {}) {
  return requestApi<Valuation>(`/stock/valuation?${query(filter)}`);
}

export function getAllStockAdjustments(filter: { status?: AdjustmentStatus; page?: number; pageSize?: number } = {}) {
  return requestApi<{ data: AdjustmentSummary[]; page: number; pageSize: number; total: number }>(`/stock-adjustments?${query(filter)}`);
}

export function getStockAdjustmentById(id: string) {
  return requestApi<Adjustment>(`/stock-adjustments/${id}`);
}

/** The key makes a double click or a retry after a dropped connection apply the adjustment once. */
export function createStockAdjustment(input: StockAdjustmentInput, idempotencyKey: string) {
  return requestApi<Adjustment>("/stock-adjustments", { method: "POST", body: JSON.stringify(input), headers: { "Idempotency-Key": idempotencyKey } });
}

export function approveStockAdjustment(id: string, idempotencyKey: string) {
  return requestApi<Adjustment>(`/stock-adjustments/${id}/approve`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey } });
}

export function rejectStockAdjustment(id: string, reason: string) {
  return postJson<Adjustment>(`/stock-adjustments/${id}/reject`, { reason });
}

export function previewOpeningStock(csv: string) {
  return postJson<OpeningStockPreview>("/stock/opening/preview", { csv });
}

export function importOpeningStock(csv: string, idempotencyKey: string) {
  return requestApi<OpeningStockResult>("/stock/opening", { method: "POST", body: JSON.stringify({ csv }), headers: { "Idempotency-Key": idempotencyKey } });
}
