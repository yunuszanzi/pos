import type { ChallanStatus } from "../../shared/schemas/deliveryChallans";
import type { ConvertQuotationInput, SalesOrderInput, SalesOrderStatus } from "../../shared/schemas/salesOrders";
import { postJson, requestApi } from "./client";

export type SalesOrderSummary = {
  id: string; number: string; status: SalesOrderStatus; orderDate: string; deliveryDate: string | null; totalPaisa: number; customerPo: string; customerName: string;
};
export type SalesOrderPage = { data: SalesOrderSummary[]; page: number; pageSize: number; total: number };
export type SalesOrderFilter = { status?: SalesOrderStatus | "active" | ""; customerId?: string; q?: string; page?: number; pageSize?: number };

export type SalesOrderLine = {
  id: string; lineNo: number; variantId: string; unitId: string; productName: string; variantName: string; sku: string; unitName: string; hsCode: string | null;
  quantity: string; factorToBase: string; qtyBase: string; deliveredBase: string; invoicedBase: string; remainingBase: string; unassignedBase: string; billableBase: string;
  unitPricePaisa: number; grossPaisa: number; lineDiscountPaisa: number; invoiceDiscountSharePaisa: number; netPaisa: number; taxRateBps: number; taxPaisa: number; totalPaisa: number;
};
export type SalesOrder = {
  id: string; number: string; status: SalesOrderStatus; customerId: string; customerName: string; customerPhone: string; customerNtn: string | null; customerStrn: string | null;
  branchId: string; branchName: string; locationId: string; locationName: string; quotationId: string | null; quotationNumber: string | null;
  customerPo: string; orderDate: string; deliveryDate: string | null; deliveryAddress: string; note: string; taxMode: "inclusive" | "exclusive";
  grossPaisa: number; lineDiscountPaisa: number; invoiceDiscountPaisa: number; taxablePaisa: number; taxPaisa: number; roundingPaisa: number; totalPaisa: number; createdAt: string;
  lines: SalesOrderLine[];
  invoices: Array<{ id: string; number: string; postedAt: string; totalPaisa: number; dueDate: string | null }>;
  challans: Array<{ id: string; number: string; status: ChallanStatus; driverName: string; vehicleNo: string; dispatchedAt: string | null }>;
};
export type StockAfter = Array<{ variantId: string; onHand: string; reserved: string; available: string }>;
export type OrderResult = { order: SalesOrder; stock: StockAfter };

function query(filter: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") search.set(key, String(value));
  return search.toString();
}

export const getAllSalesOrders = (filter: SalesOrderFilter = {}, signal?: AbortSignal) => requestApi<SalesOrderPage>(`/sales-orders?${query(filter)}`, { signal });
export const getSalesOrderById = (id: string) => requestApi<SalesOrder>(`/sales-orders/${id}`);
/** The idempotency key identifies one order: retrying with the same key can never take it, and reserve the stock, twice. */
export const postSalesOrder = (input: SalesOrderInput, idempotencyKey: string) => postJson<OrderResult>("/sales-orders", input, { "Idempotency-Key": idempotencyKey });
export const postQuotationConversion = (quotationId: string, input: ConvertQuotationInput, idempotencyKey: string) =>
  postJson<OrderResult>(`/quotations/${quotationId}/convert-to-order`, input, { "Idempotency-Key": idempotencyKey });
export const moveSalesOrder = (id: string, action: "cancel" | "close", idempotencyKey: string) => postJson<OrderResult>(`/sales-orders/${id}/${action}`, {}, { "Idempotency-Key": idempotencyKey });
