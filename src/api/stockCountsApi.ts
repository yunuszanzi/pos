import type { CountEntriesInput, ScanCountInput, StartStockCountInput, StockCountStatus } from "../../shared/schemas/stockCounts";
import { postJson, requestApi } from "./client";

export type StockCountSummary = {
  id: string; number: string; status: StockCountStatus; scope: "full" | "partial"; locationName: string; items: number; counted: number;
  startedAt: string; approvedAt: string | null;
};
export type StockCountList = { data: StockCountSummary[]; page: number; pageSize: number; total: number };

export type CountLine = {
  variantId: string; sku: string; productName: string; variantName: string; unitName: string; baseUnitId: string;
  expectedBase: string; countedBase: string | null; varianceBase: string | null; movedSinceBase: string;
  /** Absent without products.cost.view. */
  costPaisa?: number; varianceValuePaisa?: number | null;
};
export type StockCount = {
  id: string; number: string; status: StockCountStatus; scope: "full" | "partial"; locationId: string; locationName: string;
  note: string; reviewNote: string; adjustmentId: string | null;
  startedAt: string; createdByName: string | null; submittedAt: string | null; submittedByName: string | null; approvedAt: string | null; approvedByName: string | null; cancelledAt: string | null;
  summary: { items: number; counted: number; uncounted: number; differences: number; overUnits: string; shortUnits: string; netValuePaisa?: number; overValuePaisa?: number; shortValuePaisa?: number };
  lines: { page: number; pageSize: number; total: number; data: CountLine[] };
};
export type CountLineFilter = { filter?: "all" | "uncounted" | "differences"; q?: string; page?: number; pageSize?: number };
export type ScanResult = { variantId: string; sku: string; productName: string; countedBase: string; expectedBase: string };

function query(filter: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") search.set(key, String(value));
  return search.toString();
}

export const getAllStockCounts = (status = "", page = 1, signal?: AbortSignal) => requestApi<StockCountList>(`/stock-counts?${query({ status, page })}`, { signal });
export const getStockCountById = (id: string, filter: CountLineFilter = {}, signal?: AbortSignal) => requestApi<StockCount>(`/stock-counts/${id}?${query(filter)}`, { signal });
/** The idempotency key identifies one count: retrying with the same key can never start two. */
export const startStockCount = (input: StartStockCountInput, idempotencyKey: string) => postJson<StockCount>("/stock-counts", input, { "Idempotency-Key": idempotencyKey });
export const postCountEntries = (id: string, input: CountEntriesInput) => postJson<StockCount>(`/stock-counts/${id}/entries`, input);
export const postCountScan = (id: string, input: ScanCountInput) => postJson<ScanResult>(`/stock-counts/${id}/scan`, input);
export const moveStockCount = (id: string, action: "submit" | "reopen" | "approve" | "cancel", note: string, idempotencyKey: string) =>
  postJson<StockCount>(`/stock-counts/${id}/${action}`, { note }, { "Idempotency-Key": idempotencyKey });
