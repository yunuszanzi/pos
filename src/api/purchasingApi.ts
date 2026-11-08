import type { PoStatus } from "../../shared/purchasing";
import type { GoodsReceiptInput, PurchaseOrderInput } from "../../shared/schemas/purchasing";
import type { PurchaseReturnInput } from "../../shared/schemas/supplierPayments";
import { postJson, putJson, requestApi } from "./client";

// Prices and totals are left out of every response for people who may not see costs, so they are optional here.

export type PurchaseOrderSummary = {
  id: string; number: string; status: PoStatus; orderDate: string; expectedDate: string | null; supplierName: string; totalPaisa?: number;
};
export type PurchaseOrderPage = { data: PurchaseOrderSummary[]; page: number; pageSize: number; total: number };
export type PurchaseOrderFilter = { status?: PoStatus | "open" | ""; supplierId?: string; q?: string; page?: number; pageSize?: number };

export type PurchaseOrderLine = {
  id: string; lineNo: number; variantId: string; unitId: string; productName: string; variantName: string; sku: string; unitName: string;
  quantity: string; factorToBase: string; qtyBase: string; receivedBase: string;
  /** Still to come, in the unit the line was ordered in. */
  remainingQuantity: string;
  unitCostPaisa?: number; lineTotalPaisa?: number;
};
export type PurchaseOrder = {
  id: string; number: string; status: PoStatus; supplierId: string; supplierName: string; locationId: string; locationName: string; branchName: string;
  orderDate: string; expectedDate: string | null; note: string; createdAt: string; totalPaisa?: number;
  lines: PurchaseOrderLine[];
  receipts: Array<{ id: string; number: string; receivedAt: string; supplierRef: string; totalPaisa?: number }>;
};

export type GoodsReceiptSummary = {
  id: string; number: string; receivedAt: string; supplierRef: string; supplierName: string; orderNumber: string | null; totalPaisa?: number;
};
export type GoodsReceiptPage = { data: GoodsReceiptSummary[]; page: number; pageSize: number; total: number };
export type GoodsReceipt = {
  id: string; number: string; supplierId: string; supplierName: string; locationName: string; branchName: string; orderId: string | null; orderNumber: string | null;
  supplierRef: string; note: string; receivedAt: string; receivedBy: string | null; totalPaisa?: number;
  lines: Array<{
    id: string; lineNo: number; orderLineId: string | null; variantId: string; productName: string; variantName: string; sku: string; unitName: string;
    quantity: string; qtyBase: string; billedBase: string; unitCostPaisa?: number; costPerBasePaisa?: number; lineValuePaisa?: number;
  }>;
};
export type PostedReceipt = { receipt: GoodsReceipt; stock: Array<{ variantId: string; onHand: string; averageCostPaisa?: number }> };

function query(filter: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") search.set(key, String(value));
  return search.toString();
}

export const getAllPurchaseOrders = (filter: PurchaseOrderFilter = {}, signal?: AbortSignal) => requestApi<PurchaseOrderPage>(`/purchase-orders?${query(filter)}`, { signal });
export const getPurchaseOrderById = (id: string) => requestApi<PurchaseOrder>(`/purchase-orders/${id}`);
export const createPurchaseOrder = (input: PurchaseOrderInput) => postJson<PurchaseOrder>("/purchase-orders", input);
export const updatePurchaseOrder = (id: string, input: PurchaseOrderInput) => putJson<PurchaseOrder>(`/purchase-orders/${id}`, input);
const move = (id: string, action: "send" | "cancel" | "close", idempotencyKey: string) => postJson<PurchaseOrder>(`/purchase-orders/${id}/${action}`, {}, { "Idempotency-Key": idempotencyKey });
export const sendPurchaseOrder = (id: string, idempotencyKey: string) => move(id, "send", idempotencyKey);
export const cancelPurchaseOrder = (id: string, idempotencyKey: string) => move(id, "cancel", idempotencyKey);
export const closePurchaseOrder = (id: string, idempotencyKey: string) => move(id, "close", idempotencyKey);

export const getAllGoodsReceipts = (filter: { supplierId?: string; orderId?: string; q?: string; page?: number; pageSize?: number } = {}, signal?: AbortSignal) =>
  requestApi<GoodsReceiptPage>(`/goods-receipts?${query(filter)}`, { signal });
export const getGoodsReceiptById = (id: string) => requestApi<GoodsReceipt>(`/goods-receipts/${id}`);
/** The idempotency key identifies one receipt: retrying with the same key can never receive the goods twice. */
export const postGoodsReceipt = (input: GoodsReceiptInput, idempotencyKey: string) => postJson<PostedReceipt>("/goods-receipts", input, { "Idempotency-Key": idempotencyKey });

/** What can still go back from a goods receipt, with the credit each line would carry by default. */
export type ReturnableReceipt = {
  receipt: { id: string; number: string; supplierId: string; supplierName: string };
  lines: Array<{
    id: string; lineNo: number; productName: string; variantName: string; sku: string; unitName: string; quantity: string; factorToBase: string; returnedBase: string; onHandBase: string;
    /** Left to return, in the unit it was received in. */
    returnableQuantity: string; defaultUnitCostPaisa: number; defaultTaxRateBps: number;
  }>;
};
export type PurchaseReturn = {
  id: string; number: string; postedAt: string; supplierId: string; supplierName: string; branchName: string; locationName: string; receiptId: string; receiptNumber: string; reason: string;
  subtotalPaisa: number; taxPaisa: number; totalPaisa: number; supplierBalancePaisa: number; settledBillsPaisa: number; onAccountPaisa: number;
  allocations: Array<{ billId: string; number: string; supplierInvoiceNo: string; amountPaisa: number }>;
  lines: Array<{
    id: string; lineNo: number; receiptLineId: string; productName: string; variantName: string; sku: string; unitName: string; quantity: string; qtyBase: string;
    unitCostPaisa: number; lineValuePaisa: number; taxRateBps: number; taxPaisa: number;
  }>;
};
export type PurchaseReturnSummary = { id: string; number: string; postedAt: string; totalPaisa: number; reason: string; supplierName: string; receiptNumber: string };
export type PurchaseReturnPage = { data: PurchaseReturnSummary[]; page: number; pageSize: number; total: number };

export const getReturnableReceiptLines = (receiptId: string) => requestApi<ReturnableReceipt>(`/goods-receipts/${receiptId}/returnable`);
/** The idempotency key identifies one return: retrying with the same key can never send the goods back twice. */
export const postPurchaseReturn = (input: PurchaseReturnInput, idempotencyKey: string) => postJson<PurchaseReturn>("/purchase-returns", input, { "Idempotency-Key": idempotencyKey });
export const getAllPurchaseReturns = (filter: { supplierId?: string; q?: string; page?: number; pageSize?: number } = {}, signal?: AbortSignal) =>
  requestApi<PurchaseReturnPage>(`/purchase-returns?${query(filter)}`, { signal });
export const getPurchaseReturnById = (id: string) => requestApi<PurchaseReturn>(`/purchase-returns/${id}`);
