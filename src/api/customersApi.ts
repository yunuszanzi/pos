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
