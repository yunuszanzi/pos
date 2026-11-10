import type { PostSaleInput } from "../../shared/schemas/sales";
import { deleteJson, postJson, requestApi } from "./client";
import type { Product } from "./productsApi";

import type { PrintFormat } from "../../shared/receipt";
export type { PrintFormat };
export type DataVersions = { catalogue: number; reference: number; settings: number; access: number; customers: number };

export type AppBootstrapData = {
  versions: DataVersions;
  business: { id: string; tradeName: string; legalName: string; address: string; phone: string; ntn: string | null; strn: string | null; receiptFooter: string; logoUrl: string | null };
  branch: { id: string; name: string; code: string };
  terminal: { id: string; name: string; defaultPrintFormat: PrintFormat; salesLocationId: string | null };
  settings: { currency: string; timezone: string; dateFormat: string; taxMode: "inclusive" | "exclusive"; cashRoundingPaisa: 0 | 100 | 500 | 1000; allowNegativeStock: boolean; autoPrintReceipt: boolean; returnWindowDays: number };
  user: { id: string; name: string | null; email: string | null; roleName: string | null; maxDiscountBps: number; permissions: string[] };
  shift: { id: string; openedAt: string; openingFloatPaisa: number } | null;
  taxCategories: Array<{ id: string; name: string; kind: string; rateBps: number }>;
  units: Array<{ id: string; name: string; shortName: string }>;
  categories: Array<{ id: string; name: string; parentId: string | null }>;
  brands: Array<{ id: string; name: string }>;
  paymentMethods: Array<{ id: string; code: string; name: string; kind: "cash" | "card" | "bank" | "wallet" }>;
  priceLists: Array<{ id: string; name: string }>;
};

export type ProductChanges = { version: number; hasMore: boolean; products: Product[] };

export type SaleInvoice = {
  id: string;
  number: string;
  postedAt: string;
  branchName: string;
  terminalName: string;
  cashierName: string | null;
  shiftId: string;
  customerId: string | null;
  customerName: string | null;
  /** What the customer owed straight after this invoice (negative: they hold store credit). Null for a walk-in. */
  customerBalancePaisa: number | null;
  taxMode: "inclusive" | "exclusive";
  grossPaisa: number;
  lineDiscountPaisa: number;
  invoiceDiscountPaisa: number;
  taxablePaisa: number;
  taxPaisa: number;
  roundingPaisa: number;
  totalPaisa: number;
  paidPaisa: number;
  changePaisa: number;
  balancePaisa: number;
  lines: Array<{
    lineNo: number; variantId: string; unitId: string; productName: string; variantName: string; sku: string; unitName: string; hsCode: string | null;
    quantity: string; unitPricePaisa: number; grossPaisa: number; lineDiscountPaisa: number; invoiceDiscountSharePaisa: number; netPaisa: number;
    taxRateBps: number; taxPaisa: number; totalPaisa: number; returnedQuantity: string; costPaisa?: number;
  }>;
  payments: Array<{ methodCode: string; methodName: string; amountPaisa: number; tenderedPaisa: number; changePaisa: number; reference: string }>;
};
export type PostedSale = { invoice: SaleInvoice; stock: Array<{ variantId: string; onHand: string }> };
export type SaleSummary = { id: string; number: string; postedAt: string; totalPaisa: number; paidPaisa: number; shiftId: string; cashierName: string | null };
export type SalePage = { data: SaleSummary[]; page: number; pageSize: number; total: number };
export type SaleFilter = { q?: string; shiftId?: string; from?: string; to?: string; page?: number; pageSize?: number };
export type Reprint = { invoice: SaleInvoice; format: PrintFormat; duplicate: true; reprintNumber: number };

export type Shift = {
  id: string;
  terminalId: string;
  status: "open" | "closed";
  openedBy: string;
  openedAt: string;
  openingFloatPaisa: number;
  closedAt: string | null;
  countedPaisa: number | null;
  /** Hidden from the cashier until the shift is closed. */
  expectedPaisa?: number | null;
  variancePaisa?: number | null;
  note: string;
};
export type ShiftReport = {
  invoiceCount: number; totalPaisa: number; taxPaisa: number; discountPaisa: number; roundingPaisa: number;
  /** Part of the sales left unpaid, now on customers' khata. */
  creditSalesPaisa: number;
  /** Money taken from customers against their khata during the shift, and the cash part of it. */
  customerPaymentsPaisa: number; customerPaymentsCashPaisa: number;
  /** Money paid to suppliers during the shift, and the cash part of it (which comes out of the drawer). */
  supplierPaymentsPaisa: number; supplierPaymentsCashPaisa: number;
  byMethod: Array<{ code: string; name: string; payments: number; amountPaisa: number }>;
  cashSalesPaisa: number; cashInPaisa: number; cashOutPaisa: number;
  expectedCashPaisa?: number;
};
export type ShiftReportResult = { kind: "X" | "Z"; shift: Shift; report: ShiftReport };
export type CloseShiftInput = { countedPaisa: number; countedBreakdown?: Record<string, number>; note?: string };
export type CashMovementInput = { kind: "cash_in" | "cash_out"; amountPaisa: number; reason: string };

export type HeldSaleSummary = { id: string; name: string; totalPaisa: number; heldBy: string; createdAt: string };
export type RecalledSale = { id: string; name: string; cart: unknown; totalPaisa: number };

export type DailySalesReport = {
  date: string; invoiceCount: number; grossPaisa: number; discountPaisa: number; taxPaisa: number; roundingPaisa: number; totalPaisa: number; creditPaisa: number;
  costPaisa?: number; profitPaisa?: number;
  byMethod: Array<{ code: string; name: string; payments: number; amountPaisa: number }>;
  byCashier: Array<{ name: string | null; invoiceCount: number; totalPaisa: number }>;
  topProducts: Array<{ sku: string; productName: string; quantityBase: string; totalPaisa: number }>;
};

export const getAppBootstrapData = () => requestApi<AppBootstrapData>("/pos/bootstrap");
export const getDataVersions = () => requestApi<DataVersions>("/pos/data-versions");
export const getProductChangesSince = (since: number, signal?: AbortSignal) => requestApi<ProductChanges>(`/pos/products/changes?since=${since}`, { signal });

/** The idempotency key identifies one checkout: retrying with the same key can never post a second invoice. */
export const postSaleInvoice = (sale: PostSaleInput, idempotencyKey: string) => postJson<PostedSale>("/sales", sale, { "Idempotency-Key": idempotencyKey });
export const getSaleById = (id: string) => requestApi<SaleInvoice>(`/sales/${id}`);
export function getAllSales(filter: SaleFilter = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") query.set(key, String(value));
  return requestApi<SalePage>(`/sales?${query}`, { signal });
}
export const reprintSale = (id: string, format: PrintFormat) => postJson<Reprint>(`/sales/${id}/reprint`, { format });

export const getCurrentShift = () => requestApi<Shift | null>("/shifts/current");
export const openShift = (openingFloatPaisa: number, idempotencyKey: string) => postJson<Shift>("/shifts/open", { openingFloatPaisa }, { "Idempotency-Key": idempotencyKey });
export const closeShift = (id: string, input: CloseShiftInput, idempotencyKey: string) =>
  postJson<{ shift: Shift; report: ShiftReport }>(`/shifts/${id}/close`, input, { "Idempotency-Key": idempotencyKey });
export const recordCashMovement = (shiftId: string, input: CashMovementInput, idempotencyKey: string) =>
  postJson<unknown>(`/shifts/${shiftId}/cash-movements`, input, { "Idempotency-Key": idempotencyKey });
export const getShiftReport = (id: string) => requestApi<ShiftReportResult>(`/shifts/${id}/report`);

export const getAllHeldSales = () => requestApi<HeldSaleSummary[]>("/held-sales");
export const holdSale = (sale: { name: string; cart: unknown; totalPaisa: number }) => postJson<HeldSaleSummary>("/held-sales", sale);
export const recallHeldSale = (id: string) => postJson<RecalledSale>(`/held-sales/${id}/recall`, {});
export const discardHeldSale = (id: string) => deleteJson<{ id: string }>(`/held-sales/${id}`);

export const getDailySalesReport = (date?: string) => requestApi<DailySalesReport>(`/reports/daily-sales${date ? `?date=${date}` : ""}`);

export type StockLevelNow = { variantId: string; onHand: string; reserved: string; available: string };
/** Many SKUs in one call (at most 500), for the till to show what is on the shelf. */
export const getStockLevelsForProducts = (variantIds: string[], locationId: string) =>
  postJson<StockLevelNow[]>("/stock/levels", { variantIds, locationId });
