import type { AccountEntryInput, AccountInput, AccountKind, AccountTransferInput, ExpenseInput } from "../../shared/schemas/accounts";
import { postJson, putJson, requestApi } from "./client";

export type Account = { id: string; name: string; kind: AccountKind; active: boolean; balancePaisa: number; methods: string[] };
export type AccountList = { data: Account[]; totalPaisa: number };
export type AccountEntry = { id: string; entryDate: string; amountPaisa: number; runningPaisa: number; docType: string; docId: string | null; docNumber: string; memo: string; createdAt: string };
export type AccountEntryPage = { account: Account; data: AccountEntry[]; page: number; pageSize: number; total: number };
export type TransferSummary = { id: string; number: string; transferDate: string; amountPaisa: number; memo: string; from: string; to: string };
export type TransferPage = { data: TransferSummary[]; page: number; pageSize: number; total: number };

export const getAllAccounts = () => requestApi<AccountList>("/accounts");
export const createAccount = (input: AccountInput) => postJson<Account>("/accounts", input);
export const updateAccount = (id: string, input: { name: string; active: boolean }) => putJson<Account>(`/accounts/${id}`, input);
export const getAccountEntries = (id: string, filter: { from?: string; to?: string; page?: number } = {}, signal?: AbortSignal) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) query.set(key, String(value));
  return requestApi<AccountEntryPage>(`/accounts/${id}/entries?${query}`, { signal });
};
export const postAccountEntry = (id: string, input: AccountEntryInput, idempotencyKey: string) =>
  postJson<{ account: Account; entryId: string }>(`/accounts/${id}/entries`, input, { "Idempotency-Key": idempotencyKey });
export const postAccountTransfer = (input: AccountTransferInput, idempotencyKey: string) =>
  postJson<{ transfer: TransferSummary; accounts: Account[] }>("/account-transfers", input, { "Idempotency-Key": idempotencyKey });
export const getAllAccountTransfers = (page = 1) => requestApi<TransferPage>(`/account-transfers?page=${page}`);

// ---------------------------------------------------------------- expenses

export type ExpenseCategory = { id: string; name: string; active: boolean };
export type Expense = {
  id: string; number: string; expenseDate: string; amountPaisa: number; categoryId: string; categoryName: string; paidFrom: "account" | "register";
  accountId: string | null; accountName: string | null; shiftId: string | null; branchName: string; payee: string; reference: string; note: string;
  hasAttachment: boolean; attachmentName: string | null; reversed: boolean; reversedAt: string | null; reversalReason: string | null; createdAt: string; createdByName: string | null;
};
export type ExpensePage = { data: Expense[]; page: number; pageSize: number; total: number; spentPaisa: number };
export type ExpenseFilter = { from?: string; to?: string; categoryId?: string; accountId?: string; q?: string; reversed?: "hide" | ""; page?: number; pageSize?: number };

export const getAllExpenseCategories = () => requestApi<{ data: ExpenseCategory[] }>("/expense-categories");
export const createExpenseCategory = (name: string) => postJson<ExpenseCategory>("/expense-categories", { name, active: true });
export const updateExpenseCategory = (id: string, input: { name: string; active: boolean }) => putJson<ExpenseCategory>(`/expense-categories/${id}`, input);
export function getAllExpenses(filter: ExpenseFilter = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") query.set(key, String(value));
  return requestApi<ExpensePage>(`/expenses?${query}`, { signal });
}
export const getExpenseById = (id: string) => requestApi<Expense>(`/expenses/${id}`);
/** The idempotency key identifies one expense: retrying with the same key can never record it twice. */
export const postExpense = (input: ExpenseInput, idempotencyKey: string) => postJson<Expense>("/expenses", input, { "Idempotency-Key": idempotencyKey });
export const reverseExpense = (id: string, input: { reason: string; shiftId?: string }, idempotencyKey: string) =>
  postJson<Expense>(`/expenses/${id}/reverse`, input, { "Idempotency-Key": idempotencyKey });
export function attachExpenseBill(id: string, file: File) {
  const form = new FormData();
  form.set("file", file);
  return requestApi<Expense>(`/expenses/${id}/attachment`, { method: "POST", body: form });
}
export const getExpenseBillLink = (id: string) => requestApi<{ url: string; name: string | null; expiresInSeconds: number }>(`/expenses/${id}/attachment`);
