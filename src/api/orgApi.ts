import { postJson, putJson, requestApi } from "./client";
import type { z } from "zod";
import type { branchSchema, businessUpdateSchema, documentSeriesSchema, locationSchema, setupBusinessSchema, terminalSchema } from "../../shared/schemas/org";

export type SetupBusinessInput = z.input<typeof setupBusinessSchema>;
export type BranchInput = z.input<typeof branchSchema>;
export type LocationInput = z.input<typeof locationSchema>;
export type TerminalInput = z.input<typeof terminalSchema>;
export type BusinessUpdateInput = z.input<typeof businessUpdateSchema>;
export type DocumentSeriesInput = z.input<typeof documentSeriesSchema>;
export type BusinessProfile = {
  legalName: string;
  tradeName: string;
  phone: string;
  address: string;
  ntn: string | null;
  strn: string | null;
  province: string;
  logoUrl: string | null;
  receiptFooter: string;
};

export function createBusinessSetup(input: SetupBusinessInput) {
  return postJson("/org/setup", input);
}

export function getBusinessProfile() {
  return requestApi<BusinessProfile>("/business");
}

export function updateBusinessProfile(input: BusinessUpdateInput) {
  return putJson<BusinessProfile>("/business", input);
}

export function getAllBranches() {
  return requestApi<Array<{ id: string; name: string; code: string; active: boolean }>>("/branches");
}

export function createBranch(input: BranchInput) {
  return postJson("/branches", input);
}

export function getAllLocations() {
  return requestApi<Array<{ id: string; branchId: string; name: string; type: string; active: boolean }>>("/locations");
}

export function createLocation(input: LocationInput) {
  return postJson("/locations", input);
}

export function getAllTerminals() {
  return requestApi<Array<{ id: string; branchId: string; name: string; defaultPrintFormat: string; active: boolean }>>("/terminals");
}

export function createTerminal(input: TerminalInput) {
  return postJson("/terminals", input);
}

export function getAllDocumentSeries() {
  return requestApi<Array<{ id: string; branchId: string; docType: string; prefix: string; nextNumber: number }>>("/document-series");
}

export function createDocumentSeries(input: DocumentSeriesInput) {
  return postJson("/document-series", input);
}
