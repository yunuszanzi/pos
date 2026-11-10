import type { ReceiveTransferInput, StockTransferInput, TransferStatus } from "../../shared/schemas/transfers";
import { postJson, requestApi } from "./client";

export type TransferSummary = {
  id: string; number: string; status: TransferStatus; fromName: string; toName: string; items: number;
  createdAt: string; dispatchedAt: string | null; receivedAt: string | null;
};
export type TransferPage = { data: TransferSummary[]; page: number; pageSize: number; total: number };
export type TransferFilter = { status?: TransferStatus | "open" | ""; locationId?: string; q?: string; page?: number; pageSize?: number };

export type TransferLine = {
  id: string; lineNo: number; variantId: string; unitId: string; productName: string; variantName: string; sku: string; unitName: string;
  quantity: string; factorToBase: string; qtyBase: string; receivedBase: string | null; shortageBase: string | null;
  /** Absent without products.cost.view. */
  costPaisa?: number;
};
export type Transfer = {
  id: string; number: string; status: TransferStatus; branchName: string;
  fromLocationId: string; fromName: string; fromType: string; toLocationId: string; toName: string; toType: string;
  note: string; receiveNote: string;
  createdAt: string; createdByName: string | null; dispatchedAt: string | null; dispatchedByName: string | null;
  receivedAt: string | null; receivedByName: string | null; cancelledAt: string | null;
  lines: TransferLine[];
};
export type TransferResult = { transfer: Transfer; stock?: Array<{ variantId: string; locationId: string; onHand: string }> };
export type InTransitRow = {
  transferId: string; number: string; dispatchedAt: string | null; fromName: string; toName: string; variantId: string; sku: string; productName: string; variantName: string;
  qtyBase: string; valuePaisa?: number;
};

function query(filter: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") search.set(key, String(value));
  return search.toString();
}

export const getAllStockTransfers = (filter: TransferFilter = {}, signal?: AbortSignal) => requestApi<TransferPage>(`/stock-transfers?${query(filter)}`, { signal });
export const getStockTransferById = (id: string) => requestApi<Transfer>(`/stock-transfers/${id}`);
export const getAllInTransit = () => requestApi<{ data: InTransitRow[] }>("/stock-transfers/in-transit");
/** The idempotency key identifies one transfer: retrying with the same key can never write it twice. */
export const postStockTransfer = (input: StockTransferInput, idempotencyKey: string) => postJson<TransferResult>("/stock-transfers", input, { "Idempotency-Key": idempotencyKey });
export const dispatchStockTransfer = (id: string, idempotencyKey: string) => postJson<TransferResult>(`/stock-transfers/${id}/dispatch`, {}, { "Idempotency-Key": idempotencyKey });
export const receiveStockTransfer = (id: string, input: ReceiveTransferInput, idempotencyKey: string) => postJson<TransferResult>(`/stock-transfers/${id}/receive`, input, { "Idempotency-Key": idempotencyKey });
export const cancelStockTransfer = (id: string, idempotencyKey: string) => postJson<TransferResult>(`/stock-transfers/${id}/cancel`, {}, { "Idempotency-Key": idempotencyKey });
