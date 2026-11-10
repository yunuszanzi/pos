import { postJson, requestApi } from "./client";

export type DaySummary = {
  date: string;
  shifts: Array<{ id: string; terminal: string; openedBy: string; openedAt: string; closedAt: string | null; status: "open" | "closed"; openingFloatPaisa: number; expectedPaisa: number | null; countedPaisa: number | null; variancePaisa: number | null }>;
  cashVariancePaisa: number;
  sales: { bills: number; totalPaisa: number; taxPaisa: number; discountPaisa: number; creditPaisa: number; deskBills: number };
  returns: { count: number; totalPaisa: number; refundedPaisa: number };
  byMethod: Array<{ method: string; salesPaisa: number; receiptsPaisa: number; paidOutPaisa: number; refundsPaisa: number }>;
  expenses: { count: number; totalPaisa: number; byCategory: Array<{ category: string; expenses: number; amountPaisa: number }> };
};
export type DayPreview = { branchId: string; branchName: string; date: string; summary: DaySummary; openShifts: string | null; closingId: string | null };
export type DayClosing = {
  id: string; number: string; branchId: string; branchName: string; businessDate: string; closedAt: string; closedByName: string | null; note: string;
  reopened: boolean; reopenedAt: string | null; reopenedByName: string | null; reopenReason: string | null; summary: DaySummary;
};
export type DayClosingRow = Omit<DayClosing, "summary"> & { salesPaisa: number; bills: number; cashVariancePaisa: number };
export type DayClosingPage = { data: DayClosingRow[]; page: number; pageSize: number; total: number };

export const getDayPreview = (branchId: string, date: string, signal?: AbortSignal) =>
  requestApi<DayPreview>(`/day-closings/preview?${new URLSearchParams({ ...(branchId ? { branchId } : {}), date })}`, { signal });
export const getAllDayClosings = (page = 1) => requestApi<DayClosingPage>(`/day-closings?page=${page}`);
export const getDayClosingById = (id: string) => requestApi<DayClosing>(`/day-closings/${id}`);
/** The idempotency key identifies one closing: retrying with the same key can never close the day twice. */
export const postDayClosing = (input: { branchId?: string; date: string; note: string }, idempotencyKey: string) => postJson<DayClosing>("/day-closings", input, { "Idempotency-Key": idempotencyKey });
export const reopenDayClosing = (id: string, reason: string, idempotencyKey: string) => postJson<DayClosing>(`/day-closings/${id}/reopen`, { reason }, { "Idempotency-Key": idempotencyKey });
