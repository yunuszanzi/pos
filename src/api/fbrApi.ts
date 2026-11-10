import type { FbrEnvironment, FbrMode, FbrReferenceKind, FbrStatus } from "../../shared/fbr";
import type { FbrConfigInput } from "../../shared/schemas/fbr";
import { deleteJson, postJson, putJson, requestApi } from "./client";

export type FbrScenario = { id: string; title: string; saleType: string; rateBps: number; registered: boolean; passed: boolean | null; message: string; ranAt: string | null };
export type FbrConfig = {
  enabled: boolean; mode: FbrMode; environment: FbrEnvironment;
  seller: { name: string; ntn: string; strn: string; province: string; address: string };
  suggestedSeller: { name: string; ntn: string; strn: string; province: string; address: string };
  token: { set: boolean; hint: string | null; setAt: string | null };
  cancelWindowHours: number; buyerIdThresholdPaisa: number;
  lastTest: { at: string; ok: boolean; message: string } | null;
  lastSyncAt: string | null;
  referenceCounts: Record<FbrReferenceKind, number>;
  scenarios: FbrScenario[];
  allScenariosPassed: boolean;
  /** "mock" means a built-in stand-in is answering instead of FBR (development and tests). */
  adapter: "mock" | "live";
};
export type FbrReadiness = { sellerProblems: string[]; gaps: Array<{ key: string; title: string; total: number; examples: string[]; blocksSales: boolean }>; ready: boolean };
export type FbrTerminal = { id: string; name: string; branchName: string; fbrPosId: string; fbrEnabled: boolean; active: boolean };
export type FbrPaymentMethod = { id: string; name: string; kind: string; fbrPaymentCode: string; active: boolean };
export type FbrTaxCategory = { id: string; name: string; kind: string; rateBps: number; fbrSaleType: string; sroScheduleNo: string; sroItemSerialNo: string; active: boolean };
export type FbrSubmission = {
  id: string; docType: "sales_invoice" | "sales_return"; docId: string; number: string; status: FbrStatus; environment: FbrEnvironment; attempts: number; irn: string | null;
  errorCode: string | null; errorMessage: string | null; nextRetryAt: string | null; lastAttemptAt: string | null; createdAt: string; acceptedAt: string | null;
};
export type FbrSubmissionDetail = FbrSubmission & {
  refIrn: string | null; payload: unknown; response: unknown;
  attempts: never;
  attemptLog: never;
};
export type FbrAttempt = { id: string; attemptNo: number; step: "local" | "validate" | "post"; outcome: string; httpStatus: number | null; message: string; request: unknown; response: unknown; createdAt: string };
export type FbrSubmissionView = Omit<FbrSubmissionDetail, "attempts" | "attemptLog"> & { attempts: FbrAttempt[] };
export type FbrSubmissionPage = { data: FbrSubmission[]; page: number; pageSize: number; total: number };
export type FbrSubmissionFilter = { status?: FbrStatus | "attention" | ""; docType?: "sales_invoice" | "sales_return" | ""; from?: string; to?: string; q?: string; page?: number };
export type SyncResult = { results: Array<{ kind: FbrReferenceKind; ok: boolean; count: number; message: string }> };

export const getFbrConfig = () => requestApi<FbrConfig>("/fbr/config");
export const saveFbrConfig = (input: FbrConfigInput) => putJson<FbrConfig>("/fbr/config", input);
export const saveFbrToken = (token: string) => putJson<FbrConfig>("/fbr/token", { token });
export const removeFbrToken = () => deleteJson<FbrConfig>("/fbr/token");
export const testFbrConnection = () => postJson<{ ok: boolean; message: string; environment: FbrEnvironment; adapter: string }>("/fbr/test", {});
export const syncFbrReference = () => postJson<SyncResult>("/fbr/sync-reference", {});
export const getFbrReadiness = () => requestApi<FbrReadiness>("/fbr/readiness");
export const getFbrTerminals = () => requestApi<{ data: FbrTerminal[] }>("/fbr/terminals");
export const saveFbrTerminal = (id: string, input: { fbrPosId: string; fbrEnabled: boolean }) => putJson<{ ok: true }>(`/fbr/terminals/${id}`, input);
export const getFbrPaymentMethods = () => requestApi<{ data: FbrPaymentMethod[] }>("/fbr/payment-methods");
export const saveFbrPaymentMethod = (id: string, fbrPaymentCode: string) => putJson<{ ok: true }>(`/fbr/payment-methods/${id}`, { fbrPaymentCode });
export const getFbrTaxCategories = () => requestApi<{ data: FbrTaxCategory[] }>("/fbr/tax-categories");
export const saveFbrTaxCategory = (id: string, input: { fbrSaleType: string; sroScheduleNo: string; sroItemSerialNo: string }) => putJson<{ ok: true }>(`/fbr/tax-categories/${id}`, input);
export const getFbrReference = (kind: FbrReferenceKind, q = "", pageSize = 25) => requestApi<{ data: Array<{ code: string; description: string }>; total: number }>(`/fbr/reference?${new URLSearchParams({ kind, q, pageSize: String(pageSize) })}`);
export const verifyFbrBuyer = (registrationNo: string) => postJson<{ ok: boolean; registered?: boolean; message: string }>("/fbr/verify-buyer", { registrationNo });

export function getAllFbrSubmissions(filter: FbrSubmissionFilter = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") query.set(key, String(value));
  return requestApi<FbrSubmissionPage>(`/fbr/submissions?${query}`, { signal });
}
export const getFbrSubmissionById = (id: string) => requestApi<FbrSubmissionView>(`/fbr/submissions/${id}`);
export const getFbrSummary = () => requestApi<{ pending: number; rejected: number; failed: number; accepted: number }>("/fbr/summary");
/** The idempotency key identifies one resubmission: pressing twice cannot send it twice. */
export const resubmitToFbr = (id: string, idempotencyKey: string) => postJson<{ id: string; status: FbrStatus; irn: string | null; message: string }>(`/fbr/submissions/${id}/retry`, {}, { "Idempotency-Key": idempotencyKey });
export const runFbrScenario = (id: string) => postJson<{ id: string; passed: boolean; message: string }>(`/fbr/scenarios/${id}/run`, {});
