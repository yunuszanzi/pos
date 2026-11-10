import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../lib/db";
import { apiError } from "../../lib/http";
import { getPrincipal, hasPermission, requirePermission, type Principal } from "../../lib/permissions";
import { neutraliseFormula, toCsv } from "../../../shared/csv";
import { reportCellCsv, type ReportCell, type ReportColumn, type ReportInfo, type ReportResult } from "../../../shared/reports";
import { reportByKey, reportCatalogue, type ReportContext, type ReportDef } from "./catalogue";
import { canSeeCost, quantityText } from "../products/service";

export const reportsRoutes = new Hono();

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());

/** One trading day (Asia/Karachi) of posted sales: totals, tender mix, cashiers and best sellers. Cost and profit only for those who may see costs. */
reportsRoutes.get("/reports/daily-sales", requirePermission("reports.sales.view"), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const date = context.req.query("date") ?? today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return apiError(context, 400, "INVALID_DATE", "The date must look like 2026-11-30");
  const branchId = context.req.query("branchId");
  if (branchId && !/^[0-9a-f-]{36}$/i.test(branchId)) return apiError(context, 400, "INVALID_BRANCH", "Choose a valid branch");
  const day = sql`i.business_id = ${businessId}
    and i.posted_at >= (${date}::date)::timestamp at time zone 'Asia/Karachi'
    and i.posted_at < (${date}::date + 1)::timestamp at time zone 'Asia/Karachi'
    ${branchId ? sql`and i.branch_id = ${branchId}` : sql``}`;
  const withCost = canSeeCost(principal);

  const [totals] = await db.execute(sql`
    select count(*)::int as invoices, coalesce(sum(i.gross_paisa), 0)::bigint as gross,
           coalesce(sum(i.line_discount_paisa + i.invoice_discount_paisa), 0)::bigint as discount, coalesce(sum(i.tax_paisa), 0)::bigint as tax,
           coalesce(sum(i.rounding_paisa), 0)::bigint as rounding, coalesce(sum(i.total_paisa), 0)::bigint as total,
           coalesce(sum(i.balance_paisa), 0)::bigint as balance
    from sales_invoices i where ${day}
  `);
  const [costs] = withCost ? await db.execute(sql`
    select coalesce(sum(round(l.qty_base * l.cost_paisa)), 0)::bigint as cost
    from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id where ${day}
  `) : [];
  const byMethod = await db.execute(sql`
    select p.method_code, p.method_name, count(*)::int as payments, sum(p.amount_paisa)::bigint as amount
    from payments p join sales_invoices i on i.id = p.invoice_id where ${day} group by p.method_code, p.method_name order by amount desc
  `);
  const byCashier = await db.execute(sql`
    select u.display_name as name, count(*)::int as invoices, sum(i.total_paisa)::bigint as total
    from sales_invoices i left join users u on u.id = i.cashier_id where ${day} group by u.display_name order by total desc
  `);
  const topProducts = await db.execute(sql`
    select l.sku, l.product_name, sum(l.qty_base)::text as qty_base, sum(l.total_paisa)::bigint as total
    from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id where ${day}
    group by l.sku, l.product_name order by total desc, l.sku limit 10
  `);

  const total = Number(totals.total);
  const cost = withCost ? Number(costs.cost) : null;
  return context.json({
    date,
    invoiceCount: Number(totals.invoices),
    grossPaisa: Number(totals.gross),
    discountPaisa: Number(totals.discount),
    taxPaisa: Number(totals.tax),
    roundingPaisa: Number(totals.rounding),
    totalPaisa: total,
    creditPaisa: Number(totals.balance),
    ...(cost === null ? {} : { costPaisa: cost, profitPaisa: total - Number(totals.tax) - cost }),
    byMethod: byMethod.map((row) => ({ code: row.method_code, name: row.method_name, payments: Number(row.payments), amountPaisa: Number(row.amount) })),
    byCashier: byCashier.map((row) => ({ name: row.name, invoiceCount: Number(row.invoices), totalPaisa: Number(row.total) })),
    topProducts: topProducts.map((row) => ({ sku: row.sku, productName: row.product_name, quantityBase: quantityText(String(row.qty_base)), totalPaisa: Number(row.total) })),
  });
});

// ---------------------------------------------------------------- the report catalogue (SRS 7.2)

const uuidQuery = (value: string | undefined) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined);
const dayQuery = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined);
const maxRangeDays = 3660;
const csvRowLimit = 50_000;

/** A report may be run by someone who holds everything it needs; one that shows costs or profit also needs reports.profit.view. */
function mayRun(principal: Principal, report: ReportDef): boolean {
  return report.needs.every((key) => hasPermission(principal, key)) && (!report.profit || hasPermission(principal, "reports.profit.view"));
}

reportsRoutes.get("/report-catalogue", (context) => {
  const principal = getPrincipal(context);
  if (!principal.businessId) return apiError(context, 403, "PERMISSION_DENIED", "You do not have permission to perform this action");
  const data: ReportInfo[] = reportCatalogue.filter((report) => mayRun(principal, report))
    .map((report) => ({ key: report.key, title: report.title, group: report.group, description: report.description, filters: report.filters, profit: Boolean(report.profit) }));
  return context.json({ data, today: today() });
});

reportsRoutes.get("/report-data/:key", async (context) => {
  const principal = getPrincipal(context);
  const report = reportByKey.get(context.req.param("key"));
  if (!principal.businessId || !report) return apiError(context, 404, "NOT_FOUND", "There is no such report");
  if (!mayRun(principal, report)) return apiError(context, 403, "PERMISSION_DENIED", "You do not have permission to see this report");

  const query = (name: string) => context.req.query(name);
  const todayText = today();
  const to = dayQuery(query("to")) ?? todayText;
  const from = dayQuery(query("from")) ?? `${todayText.slice(0, 8)}01`;
  if (from > to) return apiError(context, 400, "INVALID_DATE", "The first day must not be after the last day");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > maxRangeDays) return apiError(context, 400, "INVALID_DATE", "Choose a range of less than ten years");
  const days = Math.min(3650, Math.max(1, Math.trunc(Number(query("days") ?? 90)) || 90));
  const search = query("q")?.trim().slice(0, 100);
  const ctx: ReportContext = {
    businessId: principal.businessId, from, to, days, q: search || undefined,
    branchId: uuidQuery(query("branchId")), terminalId: uuidQuery(query("terminalId")), userId: uuidQuery(query("userId")), customerId: uuidQuery(query("customerId")),
    supplierId: uuidQuery(query("supplierId")), categoryId: uuidQuery(query("categoryId")), variantId: uuidQuery(query("variantId")), locationId: uuidQuery(query("locationId")),
    accountId: uuidQuery(query("accountId")),
  };

  const csv = query("format") === "csv";
  const pageSize = csv ? csvRowLimit : Math.min(200, Math.max(1, Math.trunc(Number(query("pageSize") ?? 50)) || 50));
  const page = csv ? 1 : Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1);
  // Columns about cost and profit are left out for people without reports.profit.view, even in a report they may otherwise see.
  const mayProfit = hasPermission(principal, "reports.profit.view");
  const columns = report.columns.filter((column) => !column.profit || mayProfit).map(({ profit, ...column }) => { void profit; return column as ReportColumn; });

  const inner = report.inner(ctx);
  const rows = await db.execute(sql`select r.*, count(*) over () as __total from (${inner}) r order by ${sql.raw(report.orderBy)} limit ${pageSize} offset ${(page - 1) * pageSize}`);
  const summed = columns.filter((column) => column.sum);
  const [sums] = summed.length && rows.length
    ? await db.execute(sql`select ${sql.join(summed.map((column) => sql`coalesce(sum(r.${sql.raw(`"${column.key}"`)}), 0)::bigint as ${sql.raw(`"${column.key}"`)}`), sql`, `)} from (${inner}) r`)
    : [];

  const cell = (column: ReportColumn, value: unknown): ReportCell => {
    if (value === null || value === undefined) return column.type === "money" || column.type === "int" || column.type === "percent" ? null : "";
    if (column.type === "money" || column.type === "int" || column.type === "percent") return Number(value);
    if (column.type === "qty") return quantityText(String(value));
    return String(value);
  };
  const shaped = rows.map((row) => Object.fromEntries(columns.map((column) => [column.key, cell(column, row[column.key])])));
  const total = rows.length ? Number(rows[0].__total) : 0;

  if (csv) {
    const header = columns.map((column) => column.label);
    const lines = shaped.map((row) => columns.map((column) => neutraliseFormula(reportCellCsv(column, row[column.key]))));
    const totalsRow = sums ? [columns.map((column, index) => (index === 0 ? "Total" : column.sum ? reportCellCsv(column, Number(sums[column.key])) : ""))] : [];
    // A spreadsheet opens the file as UTF-8 only if it starts with a byte order mark.
    const body = `\uFEFF${toCsv([header, ...lines, ...totalsRow])}`;
    return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${report.key}-${from}-to-${to}.csv"`, "Cache-Control": "no-store" } });
  }
  const result: ReportResult = {
    key: report.key, title: report.title, columns, rows: shaped, from, to, page, pageSize, total,
    totals: sums ? Object.fromEntries(summed.map((column) => [column.key, Number(sums[column.key])])) : null,
  };
  return context.json(result);
});
