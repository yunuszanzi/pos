import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { divideRounded } from "../../../shared/money";
import { db } from "../../lib/db";
import { apiError } from "../../lib/http";
import { getPrincipal, hasPermission } from "../../lib/permissions";
import { quantityText } from "../products/service";
import { summarise } from "../shifts/routes";

// The dashboard (FR-RPT-01): today's numbers at a glance. Each figure is sent only to someone who may see it: sales to those who see sales
// reports, profit to those who see profit, balances to those who see the ledgers, and so on. The figures are the reports' own.

export const dashboardRoutes = new Hono();

const todayKarachi = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
const trendDays = 14;

dashboardRoutes.get("/dashboard", async (context) => {
  const principal = getPrincipal(context);
  if (!principal.businessId) return apiError(context, 403, "PERMISSION_DENIED", "You do not have permission to perform this action");
  const businessId = principal.businessId;
  const branchId = context.req.query("branchId");
  if (branchId && !/^[0-9a-f-]{36}$/i.test(branchId)) return apiError(context, 400, "INVALID_BRANCH", "Choose a valid branch");
  const today = todayKarachi();
  const may = (key: string) => hasPermission(principal, key);
  const day = (alias: string) => sql`${sql.raw(alias)}.business_id = ${businessId} ${branchId ? sql`and ${sql.raw(alias)}.branch_id = ${branchId}` : sql``}
    and ${sql.raw(alias)}.posted_at >= (${today}::date)::timestamp at time zone 'Asia/Karachi' and ${sql.raw(alias)}.posted_at < (${today}::date + 1)::timestamp at time zone 'Asia/Karachi'`;

  const out: Record<string, unknown> = { date: today };

  if (may("reports.sales.view")) {
    const [sales] = await db.execute(sql`select count(*)::int as bills, coalesce(sum(i.total_paisa), 0)::bigint as total, coalesce(sum(i.balance_paisa), 0)::bigint as credit from sales_invoices i where ${day("i")}`);
    const [returned] = await db.execute(sql`select count(*)::int as returns, coalesce(sum(r.total_paisa), 0)::bigint as total from sales_returns r where ${day("r")}`);
    const bills = Number(sales.bills);
    out.sales = {
      totalPaisa: Number(sales.total), bills, creditPaisa: Number(sales.credit),
      averageBillPaisa: bills > 0 ? Number(divideRounded(BigInt(sales.total as string | number), BigInt(bills))) : 0,
      returnsPaisa: Number(returned.total), returns: Number(returned.returns),
    };
    const top = await db.execute(sql`
      select l.sku, p.name as product, sum(l.qty_base)::text as quantity, sum(l.total_paisa)::bigint as total
      from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id join product_variants v on v.id = l.variant_id join products p on p.id = v.product_id
      where ${day("i")} group by l.sku, p.name order by total desc, l.sku limit 5`);
    out.topProducts = top.map((row) => ({ sku: String(row.sku), product: String(row.product), quantity: quantityText(String(row.quantity)), totalPaisa: Number(row.total) }));
    const trend = await db.execute(sql`
      select to_char(d.day, 'YYYY-MM-DD') as day, coalesce(sum(i.total_paisa), 0)::bigint as total, count(i.id)::int as bills
      from generate_series((${today}::date - make_interval(days => ${trendDays - 1}))::date, ${today}::date, interval '1 day') as d(day)
      left join sales_invoices i on i.business_id = ${businessId} ${branchId ? sql`and i.branch_id = ${branchId}` : sql``}
        and (i.posted_at at time zone 'Asia/Karachi')::date = d.day::date
      group by d.day order by d.day`);
    out.trend = trend.map((row) => ({ day: String(row.day), totalPaisa: Number(row.total), bills: Number(row.bills) }));
  }

  // Profit is sales without tax less returns, less the cost of goods sold: the profit-and-loss report's gross profit, for today.
  if (may("reports.profit.view") && may("reports.sales.view")) {
    const [row] = await db.execute(sql`
      select
        (select coalesce(sum(i.taxable_paisa), 0) from sales_invoices i where ${day("i")})
        - (select coalesce(sum(r.taxable_paisa), 0) from sales_returns r where ${day("r")}) as net_sales,
        (select coalesce(sum(round(l.qty_base * l.cost_paisa)), 0) from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id where ${day("i")})
        - (select coalesce(sum(round(rl.qty_base * rl.cost_paisa)) filter (where rl.restock_to = 'sellable'), 0) from sales_return_lines rl join sales_returns r on r.id = rl.return_id where ${day("r")}) as cost`);
    out.profit = { netSalesPaisa: Number(row.net_sales), costPaisa: Number(row.cost), grossProfitPaisa: Number(row.net_sales) - Number(row.cost) };
  }

  // Cash: what the open drawers should hold, and what the cash boxes, banks and wallets hold.
  if (may("shifts.view_all") || may("accounts.view")) {
    const cash: Record<string, number> = {};
    if (may("shifts.view_all")) {
      const open = await db.execute<{ id: string; opening_float_paisa: string }>(sql`select id, opening_float_paisa from shifts where business_id = ${businessId} and status = 'open' ${branchId ? sql`and branch_id = ${branchId}` : sql``}`);
      let drawers = 0;
      for (const shift of open) drawers += (await summarise(db, businessId, shift.id, Number(shift.opening_float_paisa))).expectedCashPaisa;
      cash.drawersPaisa = drawers;
      cash.openShifts = open.length;
    }
    if (may("accounts.view")) {
      const [accounts] = await db.execute(sql`select coalesce(sum(balance_paisa), 0)::bigint as total from accounts where business_id = ${businessId} and active`);
      cash.accountsPaisa = Number(accounts.total);
    }
    out.cash = cash;
  }

  if (may("customers.ledger")) {
    const [row] = await db.execute(sql`select coalesce(sum(balance_paisa) filter (where balance_paisa > 0), 0)::bigint as owed, count(*) filter (where balance_paisa > 0)::int as customers from customers where business_id = ${businessId}`);
    out.receivables = { totalPaisa: Number(row.owed), customers: Number(row.customers) };
  }
  if (may("suppliers.ledger")) {
    const [row] = await db.execute(sql`select coalesce(sum(balance_paisa) filter (where balance_paisa > 0), 0)::bigint as owed, count(*) filter (where balance_paisa > 0)::int as suppliers from suppliers where business_id = ${businessId}`);
    out.payables = { totalPaisa: Number(row.owed), suppliers: Number(row.suppliers) };
  }
  if (may("inventory.view")) {
    const [row] = await db.execute(sql`
      select count(*)::int as low from (
        select v.id from product_variants v join products p on p.id = v.product_id left join stock_balances b on b.variant_id = v.id
        where v.business_id = ${businessId} and v.active and p.active and p.product_type = 'stocked' and v.reorder_level > 0
        group by v.id having coalesce(sum(b.on_hand), 0) <= v.reorder_level) low_items`);
    out.lowStock = { items: Number(row.low) };
  }
  // FBR: invoices FBR refused or that were given up need someone to fix them (FR-FBR-16); the ones waiting will go by themselves.
  if (may("fbr.view")) {
    const [row] = await db.execute(sql`
      select count(*) filter (where status = 'rejected')::int as rejected, count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'pending')::int as pending
      from fbr_submissions where business_id = ${businessId}`);
    if (Number(row.rejected) + Number(row.failed) + Number(row.pending) > 0) out.fbr = { rejected: Number(row.rejected), failed: Number(row.failed), pending: Number(row.pending) };
  }
  return context.json(out);
});
