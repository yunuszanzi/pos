import type { ChallanStatus, DeliveryChallanInput, DispatchInput } from "../../shared/schemas/deliveryChallans";
import { postJson, requestApi } from "./client";
import type { StockAfter } from "./salesOrdersApi";

export type ChallanSummary = {
  id: string; number: string; status: ChallanStatus; orderNumber: string; customerName: string; driverName: string; vehicleNo: string; route: string;
  createdAt: string; dispatchedAt: string | null;
};
export type ChallanPage = { data: ChallanSummary[]; page: number; pageSize: number; total: number };
export type ChallanFilter = { status?: ChallanStatus | "active" | ""; orderId?: string; q?: string; page?: number; pageSize?: number };

export type Challan = {
  id: string; number: string; status: ChallanStatus; orderId: string; orderNumber: string; customerPo: string; customerId: string; customerName: string; customerPhone: string;
  branchName: string; locationName: string; driverName: string; vehicleNo: string; route: string; deliveryAddress: string; note: string; returnReason: string;
  createdAt: string; dispatchedAt: string | null; deliveredAt: string | null; returnedAt: string | null;
  lines: Array<{ id: string; lineNo: number; orderLineId: string; productName: string; variantName: string; sku: string; unitName: string; quantity: string; qtyBase: string }>;
};
export type ChallanResult = { challan: Challan; stock?: StockAfter };

function query(filter: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") search.set(key, String(value));
  return search.toString();
}

export const getAllDeliveryChallans = (filter: ChallanFilter = {}, signal?: AbortSignal) => requestApi<ChallanPage>(`/delivery-challans?${query(filter)}`, { signal });
export const getDeliveryChallanById = (id: string) => requestApi<Challan>(`/delivery-challans/${id}`);
/** The idempotency key identifies one challan: retrying with the same key can never write it twice. */
export const postDeliveryChallan = (input: DeliveryChallanInput, idempotencyKey: string) => postJson<ChallanResult>("/delivery-challans", input, { "Idempotency-Key": idempotencyKey });
export const dispatchDeliveryChallan = (id: string, input: DispatchInput, idempotencyKey: string) => postJson<ChallanResult>(`/delivery-challans/${id}/dispatch`, input, { "Idempotency-Key": idempotencyKey });
export const moveDeliveryChallan = (id: string, action: "deliver" | "cancel", idempotencyKey: string) => postJson<ChallanResult>(`/delivery-challans/${id}/${action}`, {}, { "Idempotency-Key": idempotencyKey });
export const returnDeliveryChallan = (id: string, reason: string, idempotencyKey: string) => postJson<ChallanResult>(`/delivery-challans/${id}/return`, { reason }, { "Idempotency-Key": idempotencyKey });
