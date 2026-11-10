import type { SalesInvoiceInput } from "../../shared/schemas/salesInvoices";
import { postJson, requestApi } from "./client";

export type InvoiceSummary = {
  id: string; number: string; postedAt: string; dueDate: string | null; termsDays: number | null; totalPaisa: number; outstandingPaisa: number; overdue: boolean;
  customerPo: string; customerName: string; orderNumber: string | null;
};
export type InvoicePage = { data: InvoiceSummary[]; page: number; pageSize: number; total: number };
export type InvoiceFilter = { status?: "open" | "overdue" | "paid" | ""; customerId?: string; orderId?: string; q?: string; page?: number; pageSize?: number };

export type Invoice = {
  id: string; number: string; postedAt: string; branchName: string; terminalName: string; cashierName: string | null; customerId: string | null; customerName: string | null;
  customerBalancePaisa: number | null; taxMode: "inclusive" | "exclusive";
  grossPaisa: number; lineDiscountPaisa: number; invoiceDiscountPaisa: number; taxablePaisa: number; taxPaisa: number; roundingPaisa: number; totalPaisa: number;
  paidPaisa: number; changePaisa: number; balancePaisa: number;
  channel: "pos" | "back_office"; orderId: string | null; orderNumber: string | null; quotationId: string | null; termsDays: number | null; dueDate: string | null;
  customerPo: string; note: string; buyerName: string; buyerNtn: string | null; buyerStrn: string | null; buyerAddress: string;
  /** What is still owing after payments received since (back-office invoices). */
  outstandingPaisa?: number;
  lines: Array<{
    lineNo: number; productName: string; variantName: string; sku: string; unitName: string; quantity: string; unitPricePaisa: number; grossPaisa: number; lineDiscountPaisa: number;
    invoiceDiscountSharePaisa: number; netPaisa: number; taxRateBps: number; taxPaisa: number; totalPaisa: number; costPaisa?: number;
  }>;
};

function query(filter: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") search.set(key, String(value));
  return search.toString();
}

export const getAllSalesInvoices = (filter: InvoiceFilter = {}, signal?: AbortSignal) => requestApi<InvoicePage>(`/sales-invoices?${query(filter)}`, { signal });
export const getSalesInvoiceById = (id: string) => requestApi<Invoice>(`/sales-invoices/${id}`);
/** The idempotency key identifies one invoice: retrying with the same key can never post it, and bill the customer, twice. */
export const postSalesInvoice = (input: SalesInvoiceInput, idempotencyKey: string) => postJson<{ invoice: Invoice }>("/sales-invoices", input, { "Idempotency-Key": idempotencyKey });
