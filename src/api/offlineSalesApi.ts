import { postJson, requestApi } from "./client";

export type OfflineSaleFlag = { code: string; label: string };
export type OfflineSaleRow = {
  invoiceId: string; number: string; offlineRef: string | null; soldAt: string | null; syncedAt: string | null; totalPaisa: number; cashierName: string | null;
  flags: OfflineSaleFlag[]; detail: Record<string, unknown>; reviewedAt: string | null; reviewedByName: string | null; reviewNote: string;
};
export type OfflineSalePage = { data: OfflineSaleRow[]; page: number; pageSize: number; total: number };

export const getAllOfflineSales = (status: "open" | "reviewed", page = 1, signal?: AbortSignal) =>
  requestApi<OfflineSalePage>(`/offline-sales?${new URLSearchParams({ status, page: String(page) })}`, { signal });
/** The idempotency key identifies one review: pressing twice records it once. */
export const reviewOfflineSale = (invoiceId: string, note: string, idempotencyKey: string) =>
  postJson<{ ok: true }>(`/offline-sales/${invoiceId}/review`, { note }, { "Idempotency-Key": idempotencyKey });
