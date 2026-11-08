import type { CustomerPaymentInput } from "../../shared/schemas/customerPayments";
import type { CustomerInput } from "../../shared/schemas/customers";
import { deleteJson, postJson, putJson, requestApi } from "./client";

export type Customer = {
  id: string;
  name: string;
  businessName: string;
  phone: string;
  phone2: string;
  whatsapp: string;
  email: string;
  address: string;
  areaId: string | null;
  groupId: string | null;
  /** Only for people who may manage customers. */
  cnic?: string | null;
  ntn: string | null;
  strn: string | null;
  registered: boolean;
  priceListId: string | null;
  creditLimitPaisa: number;
  termsDays: number;
  notes: string;
  active: boolean;
  /** Only for people who may see the khata. */
  balancePaisa?: number;
};
export type CustomerPage = { data: Customer[]; page: number; pageSize: number; total: number };
export type CustomerFilter = { q?: string; active?: "true" | "false" | "all"; areaId?: string; groupId?: string; page?: number; pageSize?: number };
export type Area = { id: string; name: string; active: boolean };
export type CustomerGroup = { id: string; name: string; priceListId: string | null; active: boolean };

/** What a till keeps about a customer: no CNIC, notes or email, and the price list already resolved. */
export type TillCustomer = {
  id: string;
  name: string;
  businessName: string;
  phone: string;
  phone2: string;
  whatsapp: string;
  address: string;
  areaId: string | null;
  groupId: string | null;
  registered: boolean;
  ntn: string | null;
  strn: string | null;
  priceListId: string | null;
  creditLimitPaisa: number;
  termsDays: number;
  /** What they owe at the last sync (negative: store credit). Updated from each sale and payment response. */
  balancePaisa: number;
  active: boolean;
};
export type CustomerChanges = { version: number; hasMore: boolean; customers: TillCustomer[] };
export type PriceListItems = { id: string; name: string; items: Array<{ variantId: string; unitId: string; minQuantity: string; pricePaisa: number }> };

export function getAllCustomers(filter: CustomerFilter = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") query.set(key, String(value));
  return requestApi<CustomerPage>(`/customers?${query}`, { signal });
}
export const getCustomerById = (id: string) => requestApi<Customer>(`/customers/${id}`);
export const createCustomer = (input: CustomerInput) => postJson<Customer>("/customers", input);
export const updateCustomer = (id: string, input: CustomerInput) => putJson<Customer>(`/customers/${id}`, input);
export const archiveCustomer = (id: string) => deleteJson<{ id: string; active: false }>(`/customers/${id}`);
/** The till's quick add: a name and a phone. */
export const quickAddCustomer = (input: { name: string; phone: string }) => postJson<Customer>("/customers/quick", input);

export const getAllAreas = () => requestApi<Area[]>("/areas");
export const createArea = (input: { name: string }) => postJson<Area>("/areas", input);
export const updateArea = (id: string, input: { name: string; active?: boolean }) => putJson<Area>(`/areas/${id}`, input);
export const getAllCustomerGroups = () => requestApi<CustomerGroup[]>("/customer-groups");
export const createCustomerGroup = (input: { name: string; priceListId: string | null }) => postJson<CustomerGroup>("/customer-groups", input);
export const updateCustomerGroup = (id: string, input: { name: string; priceListId: string | null; active?: boolean }) => putJson<CustomerGroup>(`/customer-groups/${id}`, input);

export const getCustomerChangesSince = (since: number, signal?: AbortSignal) => requestApi<CustomerChanges>(`/pos/customers/changes?since=${since}`, { signal });
export const getPriceListItems = (id: string) => requestApi<PriceListItems>(`/pos/price-lists/${id}`);

export type OpenInvoice = { invoiceId: string; number: string; postedAt: string; totalPaisa: number; outstandingPaisa: number; overdue: boolean };
export type LedgerEntry = {
  id: string; docType: string; docId: string; docNumber: string; memo: string; debitPaisa: number; creditPaisa: number; at: string; balanceAfterPaisa: number;
};
export type CustomerLedger = {
  customer: { id: string; name: string; balancePaisa: number; creditLimitPaisa: number; termsDays: number };
  openInvoices: OpenInvoice[];
  entries: LedgerEntry[];
  page: number; pageSize: number; total: number;
};
export type CustomerPayment = {
  id: string; number: string; postedAt: string; customerId: string; customerName: string; branchName: string; receivedBy: string | null;
  methodCode: string; methodName: string; amountPaisa: number; reference: string; note: string; customerBalancePaisa: number;
  allocations: Array<{ invoiceId: string; number: string; amountPaisa: number }>;
};

export const getCustomerLedger = (id: string, page = 1, signal?: AbortSignal) => requestApi<CustomerLedger>(`/customers/${id}/ledger?page=${page}`, { signal });
/** Receives money from a customer; the oldest invoices are settled first unless `allocations` names the ones to settle. */
export const postCustomerPayment = (input: CustomerPaymentInput, idempotencyKey: string) =>
  postJson<CustomerPayment>("/customer-payments", input, { "Idempotency-Key": idempotencyKey });
