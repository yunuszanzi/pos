import type { PurchaseBillInput } from "../../shared/schemas/bills";
import { postJson, requestApi } from "./client";

// Bills are all about money, so there is nothing to leave out for people who may not see costs: they cannot reach them at all.

export type PurchaseBillSummary = {
  id: string; number: string; supplierInvoiceNo: string; billDate: string; dueDate: string; supplierName: string; totalPaisa: number; taxPaisa: number;
};
export type PurchaseBillPage = { data: PurchaseBillSummary[]; page: number; pageSize: number; total: number };

export type PurchaseBill = {
  id: string; number: string; supplierId: string; supplierName: string; branchName: string; supplierInvoiceNo: string; billDate: string; dueDate: string; note: string; createdAt: string;
  subtotalPaisa: number; chargesPaisa: number; taxPaisa: number; totalPaisa: number;
  lines: Array<{
    id: string; lineNo: number; receiptLineId: string; receiptNumber: string; productName: string; variantName: string; sku: string; unitName: string;
    quantity: string; qtyBase: string; unitCostPaisa: number; lineValuePaisa: number; taxRateBps: number; taxPaisa: number; chargeSharePaisa: number;
    receiptCostPerBasePaisa: number; absorbedPaisa: number;
  }>;
  charges: Array<{ id: string; description: string; amountPaisa: number }>;
};

/** Goods received and not yet billed, with what is left to bill in the unit it was received in. */
export type BillableLine = {
  id: string; lineNo: number; receiptId: string; receiptNumber: string; receivedAt: string; supplierRef: string; productName: string; variantName: string; sku: string; unitName: string;
  quantity: string; factorToBase: string; unbilledQuantity: string; unitCostPaisa: number;
};
export type BillableLinePage = { data: BillableLine[]; page: number; pageSize: number; total: number };

function query(filter: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") search.set(key, String(value));
  return search.toString();
}

export const getAllPurchaseBills = (filter: { supplierId?: string; q?: string; page?: number; pageSize?: number } = {}, signal?: AbortSignal) => requestApi<PurchaseBillPage>(`/purchase-bills?${query(filter)}`, { signal });
export const getPurchaseBillById = (id: string) => requestApi<PurchaseBill>(`/purchase-bills/${id}`);
export const getBillableReceiptLines = (supplierId: string, page = 1, signal?: AbortSignal) => requestApi<BillableLinePage>(`/billable-receipt-lines?${query({ supplierId, page, pageSize: 100 })}`, { signal });
/** The idempotency key identifies one bill: retrying with the same key can never enter it twice. */
export const postPurchaseBill = (input: PurchaseBillInput, idempotencyKey: string) => postJson<PurchaseBill>("/purchase-bills", input, { "Idempotency-Key": idempotencyKey });
