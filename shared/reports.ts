import { formatBps, formatPkr, toPlainRupees } from "./money";

// The report catalogue as the screen and the export see it (SRS 7.2). The queries live on the server; this is only the shape.

export const reportGroups = ["Sales", "Profit", "Inventory", "Purchasing", "Receivables and payables", "Cash", "Tax"] as const;
export type ReportGroup = (typeof reportGroups)[number];

/** How a column's value is shown. Money is integer paisa, quantities are text, percent is basis points. */
export type ColumnType = "text" | "money" | "qty" | "int" | "date" | "datetime" | "percent";

export type ReportColumn = { key: string; label: string; type: ColumnType; /** The report adds this column up for a totals row. */ sum?: boolean };

/** The filters a report can take, in the order the screen shows them. */
export const reportFilterKeys = ["dates", "branchId", "terminalId", "userId", "customerId", "supplierId", "categoryId", "variantId", "locationId", "accountId", "days", "q"] as const;
export type ReportFilterKey = (typeof reportFilterKeys)[number];

export type ReportInfo = {
  key: string;
  title: string;
  group: ReportGroup;
  description: string;
  filters: ReportFilterKey[];
  /** The report shows costs or profit. */
  profit: boolean;
};

export type ReportCell = string | number | null;
export type ReportResult = {
  key: string;
  title: string;
  columns: ReportColumn[];
  rows: Array<Record<string, ReportCell>>;
  /** Sums for the columns that add up, over every row (not only this page). */
  totals: Record<string, number> | null;
  from: string;
  to: string;
  page: number;
  pageSize: number;
  total: number;
};

/** A cell as the screen shows it: money with exactly two decimals and the Rs sign, percent with its sign. */
export function reportCellText(column: ReportColumn, value: ReportCell): string {
  if (value === null || value === undefined || value === "") return "";
  switch (column.type) {
    case "money": return formatPkr(Number(value));
    case "percent": return `${formatBps(Math.abs(Number(value)))}%`.replace(/^/, Number(value) < 0 ? "-" : "");
    default: return String(value);
  }
}

/** A cell as the export writes it: plain rupees with two decimals and no commas, so a spreadsheet reads it as a number. */
export function reportCellCsv(column: ReportColumn, value: ReportCell): string {
  if (value === null || value === undefined || value === "") return "";
  switch (column.type) {
    case "money": return toPlainRupees(Number(value));
    case "percent": return `${Number(value) < 0 ? "-" : ""}${formatBps(Math.abs(Number(value)))}`;
    default: return String(value);
  }
}
