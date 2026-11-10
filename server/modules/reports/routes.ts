import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../lib/db";
import { apiError } from "../../lib/http";
import { getPrincipal, requirePermission } from "../../lib/permissions";
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
