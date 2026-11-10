import type { ReportInfo, ReportResult } from "../../shared/reports";
import { downloadApiFile, requestApi } from "./client";

export type ReportFilters = Partial<Record<"from" | "to" | "branchId" | "terminalId" | "userId" | "customerId" | "supplierId" | "categoryId" | "variantId" | "locationId" | "accountId" | "days" | "q", string>>;

function query(filters: ReportFilters, extra: Record<string, string | number> = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) if (value !== undefined && value !== "") search.set(key, String(value));
  return search.toString();
}

export const getReportCatalogue = () => requestApi<{ data: ReportInfo[]; today: string }>("/report-catalogue");
export const getReportData = (key: string, filters: ReportFilters, page: number, pageSize: number, signal?: AbortSignal) =>
  requestApi<ReportResult>(`/report-data/${encodeURIComponent(key)}?${query(filters, { page, pageSize })}`, { signal });
/** The same report as a CSV a spreadsheet opens, with every row (up to 50,000) and a totals row. */
export const downloadReportCsv = (key: string, filters: ReportFilters) =>
  downloadApiFile(`/report-data/${encodeURIComponent(key)}?${query(filters, { format: "csv" })}`, `${key}.csv`);
