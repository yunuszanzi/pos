import type { QuotationInput, QuotationStatus } from "../../shared/schemas/quotations";
import { postJson, putJson, requestApi } from "./client";

export type QuotationSummary = {
  id: string; number: string; revisionNo: number; status: QuotationStatus; quoteDate: string; validUntil: string; totalPaisa: number;
  customerId: string | null; customerName: string;
};
export type QuotationPage = { data: QuotationSummary[]; page: number; pageSize: number; total: number };
export type QuotationFilter = { status?: QuotationStatus | "open" | ""; customerId?: string; q?: string; page?: number; pageSize?: number };

export type QuotationLine = {
  id: string; lineNo: number; variantId: string; unitId: string; productName: string; variantName: string; sku: string; unitName: string; hsCode: string | null;
  quantity: string; factorToBase: string; qtyBase: string; convertedBase: string;
  unitPricePaisa: number; grossPaisa: number; lineDiscountPaisa: number; invoiceDiscountSharePaisa: number; netPaisa: number; taxRateBps: number; taxPaisa: number; totalPaisa: number;
};
export type Quotation = {
  id: string; number: string; revisionNo: number; rootId: string; status: QuotationStatus; storedStatus: QuotationStatus; supersededBy: string | null;
  branchId: string; branchName: string; customerId: string | null; customerName: string; customerPhone: string; customerNtn: string | null; customerStrn: string | null; isProspect: boolean;
  quoteDate: string; validUntil: string; terms: string; note: string; taxMode: "inclusive" | "exclusive";
  grossPaisa: number; lineDiscountPaisa: number; invoiceDiscountPaisa: number; taxablePaisa: number; taxPaisa: number; roundingPaisa: number; totalPaisa: number;
  createdAt: string;
  lines: QuotationLine[];
  revisions: Array<{ id: string; revisionNo: number; status: QuotationStatus; totalPaisa: number; createdAt: string }>;
};

function query(filter: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") search.set(key, String(value));
  return search.toString();
}

export const getAllQuotations = (filter: QuotationFilter = {}, signal?: AbortSignal) => requestApi<QuotationPage>(`/quotations?${query(filter)}`, { signal });
export const getQuotationById = (id: string) => requestApi<Quotation>(`/quotations/${id}`);
export const createQuotation = (input: QuotationInput) => postJson<Quotation>("/quotations", input);
export const updateQuotation = (id: string, input: QuotationInput) => putJson<Quotation>(`/quotations/${id}`, input);
export type QuotationMove = "send" | "accept" | "reject" | "revise";
/** The idempotency key identifies one move: pressing the button twice can never do it twice. */
export const moveQuotation = (id: string, action: QuotationMove, idempotencyKey: string) =>
  postJson<Quotation>(`/quotations/${id}/${action}`, {}, { "Idempotency-Key": idempotencyKey });
