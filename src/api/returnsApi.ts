import type { PostReturnInput } from "../../shared/schemas/returns";
import type { PrintFormat, ReceiptCreditNote } from "../../shared/receipt";
import { postJson, requestApi } from "./client";

/** What can still be returned on an invoice, with the figures the screen needs to price a part-return (shared/returns.ts). */
export type ReturnableInvoice = {
  invoice: { id: string; number: string; postedAt: string; customerId: string | null; customerName: string | null; taxMode: "inclusive" | "exclusive"; roundingPaisa: number };
  windowDays: number;
  outsideWindow: boolean;
  /** What the customer still owes on this invoice. A return pays that off before anything is handed back. */
  owedPaisa: number;
  lines: Array<{
    lineId: string; lineNo: number; productName: string; variantName: string; sku: string; unitName: string; quantity: string; returnedQuantity: string;
    remainingQuantity: string; unitPricePaisa: number; totalPaisa: number; factorToBase: string; qtyBase: string; returnedBase: string;
    grossPaisa: number; lineDiscountPaisa: number; invoiceDiscountSharePaisa: number; taxPaisa: number; taxIncluded: boolean;
  }>;
};

export type CreditNote = ReceiptCreditNote & { id: string; invoiceId: string | null; customerId: string | null; approved: boolean; approvalNote: string | null };
export type PostedReturn = { creditNote: CreditNote; stock: Array<{ variantId: string; onHand: string }> };
export type ReturnSummary = {
  id: string; number: string; postedAt: string; totalPaisa: number; refundPaisa: number; accountCreditPaisa: number; refundMethodName: string | null;
  invoiceNumber: string | null; customerName: string | null; cashierName: string | null;
};
export type ReturnPage = { data: ReturnSummary[]; page: number; pageSize: number; total: number };
export type ReturnReprint = { creditNote: CreditNote; format: PrintFormat; duplicate: true; reprintNumber: number };

export const getReturnableLinesForInvoice = (invoiceId: string) => requestApi<ReturnableInvoice>(`/sales/${invoiceId}/returnable`);
/** The idempotency key identifies one return: retrying with the same key can never post a second credit note. */
export const postSalesReturn = (input: PostReturnInput, idempotencyKey: string) => postJson<PostedReturn>("/returns", input, { "Idempotency-Key": idempotencyKey });
export function getAllReturns(filter: { q?: string; page?: number; pageSize?: number } = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") query.set(key, String(value));
  return requestApi<ReturnPage>(`/returns?${query}`, { signal });
}
export const reprintReturn = (id: string, format: PrintFormat) => postJson<ReturnReprint>(`/returns/${id}/reprint`, { format });
