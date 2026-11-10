import { sql, type SQL } from "drizzle-orm";
import type { ReportColumn, ReportFilterKey, ReportGroup } from "../../../shared/reports";
import { escapeLike } from "../products/service";

// The report catalogue (SRS 7.2). Each report is a query that returns rows with the keys of its columns; the runner in routes.ts adds
// the paging, the totals, the permission checks and the CSV. Dates are Karachi days, `from` and `to` both included. Money is paisa.

export type ReportContext = {
  businessId: string;
  from: string;
  to: string;
  branchId?: string;
  terminalId?: string;
  userId?: string;
  customerId?: string;
  supplierId?: string;
  categoryId?: string;
  variantId?: string;
  locationId?: string;
  accountId?: string;
  days: number;
  q?: string;
};

export type ReportDef = {
  key: string;
  title: string;
  group: ReportGroup;
  description: string;
  filters: ReportFilterKey[];
  /** Every one of these permissions is needed to see the report at all. */
  needs: string[];
  /** The report shows costs or profit; it also needs reports.profit.view. */
  profit?: boolean;
  columns: Array<ReportColumn & { /** Hidden from people without reports.profit.view. */ profit?: boolean }>;
  /** The rows: a select whose column names are the column keys. */
  inner: (c: ReportContext) => SQL;
  /** How the rows are ordered, as SQL on those names. */
  orderBy: string;
};

const money = (key: string, label: string, extra: { profit?: boolean; sum?: boolean } = {}) => ({ key, label, type: "money" as const, sum: extra.sum ?? true, ...(extra.profit ? { profit: true } : {}) });
const text = (key: string, label: string) => ({ key, label, type: "text" as const });
const qty = (key: string, label: string) => ({ key, label, type: "qty" as const });
const count = (key: string, label: string) => ({ key, label, type: "int" as const, sum: true });
const date = (key: string, label: string) => ({ key, label, type: "date" as const });
const datetime = (key: string, label: string) => ({ key, label, type: "datetime" as const });
const percent = (key: string, label: string, extra: { profit?: boolean } = {}) => ({ key, label, type: "percent" as const, ...(extra.profit ? { profit: true } : {}) });

const none = sql``;
const when = (condition: unknown, fragment: SQL) => (condition ? fragment : none);
/** `column` falls in [from, to] as Karachi days. */
const within = (column: string, c: ReportContext) => sql`${sql.raw(column)} >= (${c.from}::date)::timestamp at time zone 'Asia/Karachi' and ${sql.raw(column)} < (${c.to}::date + 1)::timestamp at time zone 'Asia/Karachi'`;
const karachi = (column: string, format: string) => sql`to_char(${sql.raw(column)} at time zone 'Asia/Karachi', ${format})`;
const like = (c: ReportContext) => `%${escapeLike(c.q ?? "")}%`;
const productName = sql`p.name || coalesce(' — ' || nullif(v.variant_name, ''), '')`;
const bps = (numerator: SQL, denominator: SQL) => sql`case when ${denominator} > 0 then round((${numerator})::numeric * 10000 / (${denominator}))::int else null end`;

/** Posted sales invoices (till and desk) in the range, narrowed by branch, terminal, user and customer. Alias i. */
const invoiceScope = (c: ReportContext) => sql`i.business_id = ${c.businessId} and ${within("i.posted_at", c)}
  ${when(c.branchId, sql`and i.branch_id = ${c.branchId}`)} ${when(c.terminalId, sql`and i.terminal_id = ${c.terminalId}`)}
  ${when(c.userId, sql`and i.cashier_id = ${c.userId}`)} ${when(c.customerId, sql`and i.customer_id = ${c.customerId}`)}`;
/** Invoice lines in that scope, narrowed by product and category. Aliases l, i, v, p. */
const lineScope = (c: ReportContext) => sql`${invoiceScope(c)} ${when(c.variantId, sql`and l.variant_id = ${c.variantId}`)} ${when(c.categoryId, sql`and p.category_id = ${c.categoryId}`)}`;
const lineFrom = sql`sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id join product_variants v on v.id = l.variant_id join products p on p.id = v.product_id
  left join categories cat on cat.id = p.category_id left join brands br on br.id = p.brand_id`;
const lineCost = sql`round(l.qty_base * l.cost_paisa)`;
const returnScope = (c: ReportContext) => sql`r.business_id = ${c.businessId} and ${within("r.posted_at", c)}
  ${when(c.branchId, sql`and r.branch_id = ${c.branchId}`)} ${when(c.terminalId, sql`and r.terminal_id = ${c.terminalId}`)} ${when(c.customerId, sql`and r.customer_id = ${c.customerId}`)}`;

// ---------------------------------------------------------------- sales

const salesGrouped = (key: string, title: string, description: string, label: string, groupExpr: SQL, joinExtra: SQL = none, extraFilters: ReportFilterKey[] = []): ReportDef => ({
  key, title, group: "Sales", description, needs: ["reports.sales.view"],
  filters: ["dates", "branchId", "terminalId", "userId", "customerId", "categoryId", "variantId", ...extraFilters],
  columns: [text("name", label), qty("quantity", "Quantity (base units)"), money("sales", "Sales (with tax)"), money("tax", "Tax"), money("cost", "Cost of goods", { profit: true }), money("profit", "Profit before expenses", { profit: true })],
  inner: (c) => sql`select ${groupExpr} as name, sum(l.qty_base)::text as quantity, sum(l.total_paisa)::bigint as sales, sum(l.tax_paisa)::bigint as tax,
      sum(${lineCost})::bigint as cost, (sum(l.taxable_paisa) - sum(${lineCost}))::bigint as profit
    from ${lineFrom} ${joinExtra} where ${lineScope(c)} group by 1`,
  orderBy: "sales desc, name",
});

const sellers: ReportDef[] = [
  {
    key: "sales-summary", title: "Daily sales summary", group: "Sales", description: "Bills, discounts, tax and takings for each day.", needs: ["reports.sales.view"],
    filters: ["dates", "branchId", "terminalId", "userId", "customerId"],
    columns: [date("date", "Day"), count("bills", "Bills"), money("gross", "Gross"), money("discount", "Discounts"), money("tax", "Tax"), money("total", "Total"), money("credit", "On credit")],
    inner: (c) => sql`select ${karachi("i.posted_at", "YYYY-MM-DD")} as date, count(*)::int as bills, sum(i.gross_paisa)::bigint as gross,
        sum(i.line_discount_paisa + i.invoice_discount_paisa)::bigint as discount, sum(i.tax_paisa)::bigint as tax, sum(i.total_paisa)::bigint as total, sum(i.balance_paisa)::bigint as credit
      from sales_invoices i where ${invoiceScope(c)} group by 1`,
    orderBy: "date desc",
  },
  salesGrouped("sales-by-product", "Sales by product", "What sold, by product; sort by quantity or value to see the top and the slow sellers. Before returns.", "Product", productName),
  salesGrouped("sales-by-category", "Sales by category", "Sales grouped by product category. Before returns.", "Category", sql`coalesce(cat.name, 'No category')`),
  salesGrouped("sales-by-brand", "Sales by brand", "Sales grouped by brand. Before returns.", "Brand", sql`coalesce(br.name, 'No brand')`),
  salesGrouped("sales-by-customer", "Sales by customer", "What each customer bought. Walk-in sales are together. Before returns.", "Customer", sql`coalesce(cu.name, 'Walk-in')`, sql`left join customers cu on cu.id = i.customer_id`),
  salesGrouped("sales-by-user", "Sales by cashier or salesperson", "What each person rang up or invoiced. Before returns.", "Person", sql`coalesce(u.display_name, 'Unknown')`, sql`left join users u on u.id = i.cashier_id`),
  salesGrouped("sales-by-branch", "Sales by branch", "Sales for each branch. Before returns.", "Branch", sql`br2.name`, sql`join branches br2 on br2.id = i.branch_id`),
  salesGrouped("sales-by-terminal", "Sales by terminal", "Sales for each till; invoices written at a desk are together as Desk. Before returns.", "Terminal", sql`coalesce(t.name, 'Desk')`, sql`left join terminals t on t.id = i.terminal_id`),
  {
    key: "sales-by-hour", title: "Sales by hour", group: "Sales", description: "Which hours of the day are busy.", needs: ["reports.sales.view"],
    filters: ["dates", "branchId", "terminalId", "userId", "customerId"],
    columns: [text("hour", "Hour"), count("bills", "Bills"), money("total", "Total")],
    inner: (c) => sql`select lpad(extract(hour from i.posted_at at time zone 'Asia/Karachi')::int::text, 2, '0') || ':00' as hour, count(*)::int as bills, sum(i.total_paisa)::bigint as total
      from sales_invoices i where ${invoiceScope(c)} group by 1`,
    orderBy: "hour",
  },
  {
    key: "invoice-register", title: "Invoice register", group: "Sales", description: "Every invoice, till and desk, newest first.", needs: ["reports.sales.view"],
    filters: ["dates", "branchId", "terminalId", "userId", "customerId", "q"],
    columns: [text("number", "Invoice"), datetime("posted", "Date and time"), text("customer", "Customer"), text("user", "By"), text("channel", "Where"), money("total", "Total"), money("paid", "Paid"), money("balance", "On credit")],
    inner: (c) => sql`select i.number as number, ${karachi("i.posted_at", "YYYY-MM-DD HH24:MI")} as posted, coalesce(cu.name, 'Walk-in') as customer, coalesce(u.display_name, '') as "user",
        case when i.channel = 'back_office' then 'Desk' else coalesce(t.name, 'Till') end as channel, i.total_paisa as total, i.paid_paisa as paid, i.balance_paisa as balance, i.posted_at as sort_at
      from sales_invoices i left join customers cu on cu.id = i.customer_id left join users u on u.id = i.cashier_id left join terminals t on t.id = i.terminal_id
      where ${invoiceScope(c)} ${when(c.q, sql`and (i.number ilike ${like(c)} or cu.name ilike ${like(c)})`)}`,
    orderBy: "sort_at desc, number desc",
  },
  {
    key: "discounts", title: "Discount report", group: "Sales", description: "Invoices where a discount was given, and who approved the big ones.", needs: ["reports.sales.view"],
    filters: ["dates", "branchId", "terminalId", "userId", "customerId"],
    columns: [text("number", "Invoice"), datetime("posted", "Date and time"), text("user", "Given by"), text("approver", "Approved by"), money("gross", "Gross"), money("discount", "Discount"), percent("percent", "Of gross")],
    inner: (c) => sql`select i.number as number, ${karachi("i.posted_at", "YYYY-MM-DD HH24:MI")} as posted, coalesce(u.display_name, '') as "user", coalesce(a.display_name, '') as approver,
        i.gross_paisa as gross, (i.line_discount_paisa + i.invoice_discount_paisa)::bigint as discount, ${bps(sql`i.line_discount_paisa + i.invoice_discount_paisa`, sql`i.gross_paisa`)} as percent, i.posted_at as sort_at
      from sales_invoices i left join users u on u.id = i.cashier_id left join users a on a.id = i.approved_by
      where ${invoiceScope(c)} and i.line_discount_paisa + i.invoice_discount_paisa > 0`,
    orderBy: "sort_at desc, number desc",
  },
  {
    key: "returns", title: "Returns report", group: "Sales", description: "Goods taken back, what was refunded and what went to the customer's account.", needs: ["reports.sales.view"],
    filters: ["dates", "branchId", "terminalId", "customerId"],
    columns: [text("number", "Return"), datetime("posted", "Date and time"), text("invoice", "Against invoice"), text("customer", "Customer"), text("reason", "Reason"), money("total", "Total"), money("refund", "Refunded"), money("credit", "To account")],
    inner: (c) => sql`select r.number as number, ${karachi("r.posted_at", "YYYY-MM-DD HH24:MI")} as posted, coalesce(oi.number, '') as invoice, coalesce(cu.name, 'Walk-in') as customer, r.reason as reason,
        r.total_paisa as total, r.refund_paisa as refund, r.account_credit_paisa as credit, r.posted_at as sort_at
      from sales_returns r left join sales_invoices oi on oi.id = r.original_invoice_id left join customers cu on cu.id = r.customer_id where ${returnScope(c)}`,
    orderBy: "sort_at desc, number desc",
  },
];

// ---------------------------------------------------------------- profit (every one needs reports.profit.view)

const profitGrouped = (key: string, title: string, description: string, label: string, groupExpr: SQL, joinExtra: SQL = none): ReportDef => ({
  key, title, group: "Profit", description, needs: ["reports.profit.view"], profit: true,
  filters: ["dates", "branchId", "terminalId", "userId", "customerId", "categoryId", "variantId"],
  columns: [text("name", label), money("sales", "Sales (without tax)"), money("cost", "Cost of goods"), money("profit", "Profit"), percent("margin", "Margin")],
  inner: (c) => sql`select ${groupExpr} as name, sum(l.taxable_paisa)::bigint as sales, sum(${lineCost})::bigint as cost, (sum(l.taxable_paisa) - sum(${lineCost}))::bigint as profit,
      ${bps(sql`sum(l.taxable_paisa) - sum(${lineCost})`, sql`sum(l.taxable_paisa)`)} as margin
    from ${lineFrom} ${joinExtra} where ${lineScope(c)} group by 1`,
  orderBy: "profit desc, name",
});

const profits: ReportDef[] = [
  {
    key: "profit-by-invoice", title: "Gross profit by invoice", group: "Profit", description: "Sales without tax, the cost of what was sold, and the profit, for each invoice. Before returns.", needs: ["reports.profit.view"], profit: true,
    filters: ["dates", "branchId", "terminalId", "userId", "customerId", "q"],
    columns: [text("number", "Invoice"), datetime("posted", "Date and time"), text("customer", "Customer"), money("sales", "Sales (without tax)"), money("cost", "Cost of goods"), money("profit", "Profit"), percent("margin", "Margin")],
    inner: (c) => sql`select i.number as number, ${karachi("i.posted_at", "YYYY-MM-DD HH24:MI")} as posted, coalesce(cu.name, 'Walk-in') as customer, sum(l.taxable_paisa)::bigint as sales,
        sum(${lineCost})::bigint as cost, (sum(l.taxable_paisa) - sum(${lineCost}))::bigint as profit, ${bps(sql`sum(l.taxable_paisa) - sum(${lineCost})`, sql`sum(l.taxable_paisa)`)} as margin, max(i.posted_at) as sort_at
      from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id left join customers cu on cu.id = i.customer_id
      where ${invoiceScope(c)} ${when(c.q, sql`and (i.number ilike ${like(c)} or cu.name ilike ${like(c)})`)} group by i.id, cu.name`,
    orderBy: "sort_at desc, number desc",
  },
  profitGrouped("profit-by-product", "Gross profit by product", "Which products earn the most. Before returns.", "Product", productName),
  profitGrouped("profit-by-category", "Gross profit by category", "Which categories earn the most. Before returns.", "Category", sql`coalesce(cat.name, 'No category')`),
  profitGrouped("profit-by-customer", "Gross profit by customer", "Which customers earn the most. Before returns.", "Customer", sql`coalesce(cu.name, 'Walk-in')`, sql`left join customers cu on cu.id = i.customer_id`),
  {
    key: "profit-and-loss", title: "Profit and loss", group: "Profit", description: "Sales without tax, less returns, less the cost of goods sold, less expenses. Returned goods put back on the shelf take their cost back out of the cost of goods sold.",
    needs: ["reports.profit.view", "expenses.view"], profit: true, filters: ["dates", "branchId"],
    columns: [text("line", ""), money("amount", "Amount")],
    inner: (c) => sql`with
        sold as (select coalesce(sum(i.taxable_paisa), 0)::bigint as sales from sales_invoices i where i.business_id = ${c.businessId} and ${within("i.posted_at", c)} ${when(c.branchId, sql`and i.branch_id = ${c.branchId}`)}),
        cogs as (select coalesce(sum(round(l.qty_base * l.cost_paisa)), 0)::bigint as cost from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id
                 where i.business_id = ${c.businessId} and ${within("i.posted_at", c)} ${when(c.branchId, sql`and i.branch_id = ${c.branchId}`)}),
        back as (select coalesce(sum(r.taxable_paisa), 0)::bigint as sales from sales_returns r where r.business_id = ${c.businessId} and ${within("r.posted_at", c)} ${when(c.branchId, sql`and r.branch_id = ${c.branchId}`)}),
        backcost as (select coalesce(sum(round(rl.qty_base * rl.cost_paisa)) filter (where rl.restock_to = 'sellable'), 0)::bigint as cost from sales_return_lines rl join sales_returns r on r.id = rl.return_id
                 where r.business_id = ${c.businessId} and ${within("r.posted_at", c)} ${when(c.branchId, sql`and r.branch_id = ${c.branchId}`)}),
        spent as (select coalesce(sum(e.amount_paisa), 0)::bigint as amount from expenses e where e.business_id = ${c.businessId} and e.reversed_at is null and e.expense_date between ${c.from}::date and ${c.to}::date ${when(c.branchId, sql`and e.branch_id = ${c.branchId}`)}),
        lines(sort_no, line, amount) as (
          select 1, 'Sales (without tax)', sold.sales from sold
          union all select 2, 'Less: returns (without tax)', -back.sales from back
          union all select 3, 'Net sales', sold.sales - back.sales from sold, back
          union all select 4, 'Cost of goods sold', cogs.cost - backcost.cost from cogs, backcost
          union all select 5, 'Gross profit', (sold.sales - back.sales) - (cogs.cost - backcost.cost) from sold, back, cogs, backcost
          union all select 6, 'Less: expenses', spent.amount from spent
          union all select 7, 'Net profit', (sold.sales - back.sales) - (cogs.cost - backcost.cost) - spent.amount from sold, back, cogs, backcost, spent
        )
      select line, amount, sort_no from lines`,
    orderBy: "sort_no",
  },
];

// ---------------------------------------------------------------- inventory

const stockFilters: ReportFilterKey[] = ["categoryId", "variantId", "locationId", "q"];
const stockScope = (c: ReportContext) => sql`v.business_id = ${c.businessId} and v.active and p.active and p.product_type = 'stocked'
  ${when(c.categoryId, sql`and p.category_id = ${c.categoryId}`)} ${when(c.variantId, sql`and v.id = ${c.variantId}`)}
  ${when(c.q, sql`and (v.sku ilike ${like(c)} or p.name ilike ${like(c)})`)}`;
const stockFrom = (c: ReportContext) => sql`product_variants v join products p on p.id = v.product_id left join categories cat on cat.id = p.category_id
  left join stock_balances b on b.variant_id = v.id ${when(c.locationId, sql`and b.location_id = ${c.locationId}`)}`;

const inventory: ReportDef[] = [
  {
    key: "stock-on-hand", title: "Stock on hand", group: "Inventory", description: "What is in the shop now, what orders hold, and what is free to sell.", needs: ["inventory.view"], filters: stockFilters,
    columns: [text("sku", "SKU"), text("product", "Product"), text("category", "Category"), qty("on_hand", "On hand"), qty("reserved", "Held for orders"), qty("available", "Available")],
    inner: (c) => sql`select v.sku as sku, ${productName} as product, coalesce(cat.name, '') as category, coalesce(sum(b.on_hand), 0)::text as on_hand,
        coalesce(sum(b.reserved), 0)::text as reserved, (coalesce(sum(b.on_hand), 0) - coalesce(sum(b.reserved), 0))::text as available
      from ${stockFrom(c)} where ${stockScope(c)} group by v.id, p.id, cat.name`,
    orderBy: "product, sku",
  },
  {
    key: "stock-valuation", title: "Stock valuation", group: "Inventory", description: "What the stock on hand cost, at the weighted average cost.", needs: ["inventory.view", "products.cost.view"], profit: true, filters: stockFilters,
    columns: [text("sku", "SKU"), text("product", "Product"), qty("on_hand", "On hand"), money("avg_cost", "Average cost", { sum: false }), money("value", "Value", { profit: false })],
    inner: (c) => sql`select v.sku as sku, ${productName} as product, coalesce(sum(b.on_hand), 0)::text as on_hand,
        case when coalesce(sum(b.on_hand) filter (where b.on_hand > 0), 0) > 0 then round(sum(b.on_hand * b.avg_cost_paisa) filter (where b.on_hand > 0) / sum(b.on_hand) filter (where b.on_hand > 0))::bigint else v.cost_paisa end as avg_cost,
        coalesce(round(sum(b.on_hand * b.avg_cost_paisa) filter (where b.on_hand > 0)), 0)::bigint as value
      from ${stockFrom(c)} where ${stockScope(c)} group by v.id, p.id`,
    orderBy: "value desc, sku",
  },
  {
    key: "low-stock", title: "Low stock and reorder", group: "Inventory", description: "Items at or below their reorder level.", needs: ["inventory.view"], filters: stockFilters,
    columns: [text("sku", "SKU"), text("product", "Product"), qty("on_hand", "On hand"), qty("reorder_level", "Reorder at"), qty("reorder_quantity", "Usual order")],
    inner: (c) => sql`select v.sku as sku, ${productName} as product, coalesce(sum(b.on_hand), 0)::text as on_hand, v.reorder_level::text as reorder_level, v.reorder_quantity::text as reorder_quantity
      from ${stockFrom(c)} where ${stockScope(c)} and v.reorder_level > 0 group by v.id, p.id having coalesce(sum(b.on_hand), 0) <= v.reorder_level`,
    orderBy: "product, sku",
  },
  {
    key: "dead-stock", title: "Dead stock", group: "Inventory", description: "Items in stock that have not sold for the number of days you choose (90 if you do not choose).", needs: ["inventory.view"], filters: [...stockFilters, "days"],
    columns: [text("sku", "SKU"), text("product", "Product"), qty("on_hand", "On hand"), date("last_sold", "Last sold")],
    inner: (c) => sql`select v.sku as sku, ${productName} as product, coalesce(sum(b.on_hand), 0)::text as on_hand,
        coalesce((select to_char(max(i.posted_at) at time zone 'Asia/Karachi', 'YYYY-MM-DD') from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id where l.variant_id = v.id), 'Never') as last_sold
      from ${stockFrom(c)} where ${stockScope(c)}
        and not exists (select 1 from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id where l.variant_id = v.id and i.posted_at >= now() - make_interval(days => ${c.days}))
      group by v.id, p.id having coalesce(sum(b.on_hand), 0) > 0`,
    orderBy: "last_sold, sku",
  },
  {
    key: "stock-movements", title: "Stock ledger", group: "Inventory", description: "Every movement of stock in the dates chosen: what, where, how many and which kind of document.", needs: ["inventory.view"], filters: ["dates", "variantId", "categoryId", "locationId"],
    columns: [datetime("at", "Date and time"), text("sku", "SKU"), text("product", "Product"), text("location", "Location"), qty("quantity", "Quantity (base units)"), text("document", "Document")],
    inner: (c) => sql`select ${karachi("sl.created_at", "YYYY-MM-DD HH24:MI")} as at, v.sku as sku, ${productName} as product, loc.name as location, sl.qty_base::text as quantity, replace(sl.doc_type, '_', ' ') as document, sl.created_at as sort_at
      from stock_ledger sl join product_variants v on v.id = sl.variant_id join products p on p.id = v.product_id join locations loc on loc.id = sl.location_id
      where sl.business_id = ${c.businessId} and ${within("sl.created_at", c)} ${when(c.variantId, sql`and sl.variant_id = ${c.variantId}`)} ${when(c.categoryId, sql`and p.category_id = ${c.categoryId}`)} ${when(c.locationId, sql`and sl.location_id = ${c.locationId}`)}`,
    orderBy: "sort_at desc",
  },
];

// ---------------------------------------------------------------- purchasing (these show what things cost)

const buyers = ["purchasing.view", "products.cost.view"];
const purchasing: ReportDef[] = [
  {
    key: "purchase-register", title: "Purchase register", group: "Purchasing", description: "Supplier bills entered in the dates chosen.", needs: ["purchasing.bill", "products.cost.view"], profit: true, filters: ["dates", "branchId", "supplierId", "q"],
    columns: [text("number", "Bill"), date("bill_date", "Bill date"), text("supplier", "Supplier"), text("supplier_invoice", "Supplier's invoice"), money("subtotal", "Goods"), money("charges", "Freight and charges"), money("tax", "Input tax"), money("total", "Total")],
    inner: (c) => sql`select b.number as number, to_char(b.bill_date, 'YYYY-MM-DD') as bill_date, s.name as supplier, b.supplier_invoice_no as supplier_invoice, b.subtotal_paisa as subtotal, b.charges_paisa as charges, b.tax_paisa as tax, b.total_paisa as total
      from purchase_bills b join suppliers s on s.id = b.supplier_id
      where b.business_id = ${c.businessId} and b.bill_date between ${c.from}::date and ${c.to}::date ${when(c.branchId, sql`and b.branch_id = ${c.branchId}`)} ${when(c.supplierId, sql`and b.supplier_id = ${c.supplierId}`)}
        ${when(c.q, sql`and (b.number ilike ${like(c)} or b.supplier_invoice_no ilike ${like(c)} or s.name ilike ${like(c)})`)}`,
    orderBy: "bill_date desc, number desc",
  },
  {
    key: "purchases-by-supplier", title: "Purchases by supplier", group: "Purchasing", description: "What was bought from each supplier.", needs: ["purchasing.bill", "products.cost.view"], profit: true, filters: ["dates", "branchId", "supplierId"],
    columns: [text("supplier", "Supplier"), count("bills", "Bills"), money("subtotal", "Goods"), money("charges", "Freight and charges"), money("tax", "Input tax"), money("total", "Total")],
    inner: (c) => sql`select s.name as supplier, count(*)::int as bills, sum(b.subtotal_paisa)::bigint as subtotal, sum(b.charges_paisa)::bigint as charges, sum(b.tax_paisa)::bigint as tax, sum(b.total_paisa)::bigint as total
      from purchase_bills b join suppliers s on s.id = b.supplier_id
      where b.business_id = ${c.businessId} and b.bill_date between ${c.from}::date and ${c.to}::date ${when(c.branchId, sql`and b.branch_id = ${c.branchId}`)} ${when(c.supplierId, sql`and b.supplier_id = ${c.supplierId}`)} group by s.id`,
    orderBy: "total desc, supplier",
  },
  {
    key: "pending-purchase-orders", title: "Pending purchase orders", group: "Purchasing", description: "Orders sent to suppliers and not yet fully received.", needs: buyers, profit: true, filters: ["supplierId"],
    columns: [text("number", "Order"), date("order_date", "Ordered"), date("expected", "Expected"), text("supplier", "Supplier"), text("status", "Status"), money("total", "Order total")],
    inner: (c) => sql`select o.number as number, to_char(o.order_date, 'YYYY-MM-DD') as order_date, coalesce(to_char(o.expected_date, 'YYYY-MM-DD'), '') as expected, s.name as supplier, replace(o.status, '_', ' ') as status, o.total_paisa as total
      from purchase_orders o join suppliers s on s.id = o.supplier_id where o.business_id = ${c.businessId} and o.status in ('sent', 'partly_received') ${when(c.supplierId, sql`and o.supplier_id = ${c.supplierId}`)}`,
    orderBy: "expected, order_date",
  },
  {
    key: "grn-not-invoiced", title: "Goods received, not yet billed", group: "Purchasing", description: "Goods that came in and have no supplier bill yet, so no payable exists for them.", needs: buyers, profit: true, filters: ["supplierId", "q"],
    columns: [text("receipt", "Receipt"), date("received", "Received"), text("supplier", "Supplier"), text("sku", "SKU"), qty("unbilled", "Not yet billed (base units)"), money("value", "Value")],
    inner: (c) => sql`select g.number as receipt, ${karachi("g.received_at", "YYYY-MM-DD")} as received, s.name as supplier, gl.sku as sku, (gl.qty_base - gl.billed_base)::text as unbilled,
        round(gl.line_value_paisa * (gl.qty_base - gl.billed_base) / gl.qty_base)::bigint as value
      from goods_receipt_lines gl join goods_receipts g on g.id = gl.receipt_id join suppliers s on s.id = g.supplier_id
      where g.business_id = ${c.businessId} and gl.billed_base < gl.qty_base ${when(c.supplierId, sql`and g.supplier_id = ${c.supplierId}`)} ${when(c.q, sql`and (g.number ilike ${like(c)} or gl.sku ilike ${like(c)} or s.name ilike ${like(c)})`)}`,
    orderBy: "received, receipt",
  },
  {
    key: "purchase-returns", title: "Purchase returns", group: "Purchasing", description: "Goods sent back to suppliers and the credit they gave.", needs: ["purchasing.return", "products.cost.view"], profit: true, filters: ["dates", "branchId", "supplierId"],
    columns: [text("number", "Return"), datetime("posted", "Date and time"), text("supplier", "Supplier"), money("subtotal", "Goods"), money("tax", "Input tax"), money("total", "Credit")],
    inner: (c) => sql`select r.number as number, ${karachi("r.posted_at", "YYYY-MM-DD HH24:MI")} as posted, s.name as supplier, r.subtotal_paisa as subtotal, r.tax_paisa as tax, r.total_paisa as total, r.posted_at as sort_at
      from purchase_returns r join suppliers s on s.id = r.supplier_id
      where r.business_id = ${c.businessId} and ${within("r.posted_at", c)} ${when(c.branchId, sql`and r.branch_id = ${c.branchId}`)} ${when(c.supplierId, sql`and r.supplier_id = ${c.supplierId}`)}`,
    orderBy: "sort_at desc, number desc",
  },
];

// ---------------------------------------------------------------- receivables and payables

const owed: ReportDef[] = [
  {
    key: "receivables", title: "Customer balances", group: "Receivables and payables", description: "What customers owe the shop now (negative: credit the shop holds for them).", needs: ["customers.ledger"], filters: ["customerId", "q"],
    columns: [text("name", "Customer"), text("phone", "Phone"), money("balance", "Balance"), money("credit_limit", "Credit limit", { sum: false })],
    inner: (c) => sql`select cu.name as name, cu.phone as phone, cu.balance_paisa as balance, cu.credit_limit_paisa as credit_limit
      from customers cu where cu.business_id = ${c.businessId} and cu.balance_paisa <> 0 ${when(c.customerId, sql`and cu.id = ${c.customerId}`)} ${when(c.q, sql`and (cu.name ilike ${like(c)} or cu.phone ilike ${like(c)})`)}`,
    orderBy: "balance desc, name",
  },
  {
    key: "payables", title: "Supplier balances", group: "Receivables and payables", description: "What the shop owes suppliers now (negative: credit held with them).", needs: ["suppliers.ledger"], filters: ["supplierId", "q"],
    columns: [text("name", "Supplier"), text("phone", "Phone"), money("balance", "Balance")],
    inner: (c) => sql`select s.name as name, s.phone as phone, s.balance_paisa as balance
      from suppliers s where s.business_id = ${c.businessId} and s.balance_paisa <> 0 ${when(c.supplierId, sql`and s.id = ${c.supplierId}`)} ${when(c.q, sql`and (s.name ilike ${like(c)} or s.phone ilike ${like(c)})`)}`,
    orderBy: "balance desc, name",
  },
  {
    key: "collections", title: "Collections", group: "Receivables and payables", description: "Money received from customers in the dates chosen.", needs: ["customers.ledger"], filters: ["dates", "branchId", "customerId"],
    columns: [text("number", "Receipt"), datetime("posted", "Date and time"), text("customer", "Customer"), text("method", "Method"), text("reference", "Reference"), money("amount", "Amount")],
    inner: (c) => sql`select p.number as number, ${karachi("p.posted_at", "YYYY-MM-DD HH24:MI")} as posted, cu.name as customer, p.method_name as method, p.reference as reference, p.amount_paisa as amount, p.posted_at as sort_at
      from customer_payments p join customers cu on cu.id = p.customer_id
      where p.business_id = ${c.businessId} and ${within("p.posted_at", c)} ${when(c.branchId, sql`and p.branch_id = ${c.branchId}`)} ${when(c.customerId, sql`and p.customer_id = ${c.customerId}`)}`,
    orderBy: "sort_at desc, number desc",
  },
  {
    key: "cheques-due", title: "Cheques due", group: "Receivables and payables", description: "Cheques in hand or at the bank that are due within a week or already overdue.", needs: ["customers.cheques"], filters: ["customerId"],
    columns: [text("cheque_no", "Cheque"), text("bank", "Bank"), text("customer", "Customer"), date("cheque_date", "Cheque date"), text("status", "Status"), money("amount", "Amount")],
    inner: (c) => sql`select ch.cheque_no as cheque_no, ch.bank as bank, cu.name as customer, to_char(ch.cheque_date, 'YYYY-MM-DD') as cheque_date, ch.status as status, ch.amount_paisa as amount
      from cheques ch join customers cu on cu.id = ch.customer_id
      where ch.business_id = ${c.businessId} and ch.status in ('received', 'deposited') and ch.cheque_date <= ((now() at time zone 'Asia/Karachi')::date + 7) ${when(c.customerId, sql`and ch.customer_id = ${c.customerId}`)}`,
    orderBy: "cheque_date, cheque_no",
  },
];

// ---------------------------------------------------------------- cash

const cash: ReportDef[] = [
  {
    key: "payments-by-method", title: "Payments by method", group: "Cash", description: "For each way of paying: taken at the till, received from customers, and paid out to suppliers and as refunds.", needs: ["reports.sales.view"], filters: ["dates", "branchId"],
    columns: [text("method", "Method"), money("sales", "Taken at sales"), money("receipts", "Received from customers"), money("paid_out", "Paid to suppliers"), money("refunds", "Refunded")],
    inner: (c) => sql`with
        s as (select p.method_name as m, sum(p.amount_paisa)::bigint as amt from payments p join sales_invoices i on i.id = p.invoice_id where i.business_id = ${c.businessId} and ${within("i.posted_at", c)} ${when(c.branchId, sql`and i.branch_id = ${c.branchId}`)} group by 1),
        r as (select method_name as m, sum(amount_paisa)::bigint as amt from customer_payments where business_id = ${c.businessId} and ${within("posted_at", c)} ${when(c.branchId, sql`and branch_id = ${c.branchId}`)} group by 1),
        o as (select method_name as m, sum(amount_paisa)::bigint as amt from supplier_payments where business_id = ${c.businessId} and ${within("posted_at", c)} ${when(c.branchId, sql`and branch_id = ${c.branchId}`)} group by 1),
        f as (select refund_method_name as m, sum(refund_paisa)::bigint as amt from sales_returns where business_id = ${c.businessId} and refund_paisa > 0 and ${within("posted_at", c)} ${when(c.branchId, sql`and branch_id = ${c.branchId}`)} group by 1),
        names as (select m from s union select m from r union select m from o union select m from f)
      select names.m as method, coalesce(s.amt, 0)::bigint as sales, coalesce(r.amt, 0)::bigint as receipts, coalesce(o.amt, 0)::bigint as paid_out, coalesce(f.amt, 0)::bigint as refunds
      from names left join s on s.m = names.m left join r on r.m = names.m left join o on o.m = names.m left join f on f.m = names.m`,
    orderBy: "method",
  },
  {
    key: "expenses-by-category", title: "Expenses by category", group: "Cash", description: "What was spent, by category (reversed expenses left out).", needs: ["expenses.view"], filters: ["dates", "branchId"],
    columns: [text("category", "Category"), count("expenses", "Expenses"), money("amount", "Amount")],
    inner: (c) => sql`select cat.name as category, count(*)::int as expenses, sum(e.amount_paisa)::bigint as amount
      from expenses e join expense_categories cat on cat.id = e.category_id
      where e.business_id = ${c.businessId} and e.reversed_at is null and e.expense_date between ${c.from}::date and ${c.to}::date ${when(c.branchId, sql`and e.branch_id = ${c.branchId}`)} group by cat.id`,
    orderBy: "amount desc, category",
  },
  {
    key: "shifts", title: "Shifts and cash variance", group: "Cash", description: "Each shift's float, what the system expected, what was counted and the difference.", needs: ["shifts.view_all"], filters: ["dates", "branchId", "terminalId"],
    columns: [text("terminal", "Terminal"), text("opened_by", "Opened by"), datetime("opened", "Opened"), datetime("closed", "Closed"), money("float", "Opening float"), money("expected", "Expected cash"), money("counted", "Counted"), money("variance", "Difference")],
    inner: (c) => sql`select t.name as terminal, coalesce(u.display_name, '') as opened_by, ${karachi("s.opened_at", "YYYY-MM-DD HH24:MI")} as opened,
        coalesce(${karachi("s.closed_at", "YYYY-MM-DD HH24:MI")}, 'Still open') as closed, s.opening_float_paisa as float, coalesce(s.expected_paisa, 0)::bigint as expected, coalesce(s.counted_paisa, 0)::bigint as counted,
        coalesce(s.variance_paisa, 0)::bigint as variance, s.opened_at as sort_at
      from shifts s join terminals t on t.id = s.terminal_id left join users u on u.id = s.opened_by
      where s.business_id = ${c.businessId} and ${within("s.opened_at", c)} ${when(c.branchId, sql`and s.branch_id = ${c.branchId}`)} ${when(c.terminalId, sql`and s.terminal_id = ${c.terminalId}`)}`,
    orderBy: "sort_at desc",
  },
  {
    key: "bank-book", title: "Bank and wallet book", group: "Cash", description: "Every entry in the accounts in the dates chosen.", needs: ["accounts.view"], filters: ["dates", "accountId"],
    columns: [date("entry_date", "Date"), text("account", "Account"), text("kind", "What"), text("document", "Document"), text("memo", "Note"), money("money_in", "In"), money("money_out", "Out")],
    inner: (c) => sql`select to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, a.name as account, replace(e.doc_type, '_', ' ') as kind, e.doc_number as document, e.memo as memo,
        greatest(e.amount_paisa, 0)::bigint as money_in, greatest(-e.amount_paisa, 0)::bigint as money_out, e.created_at as sort_at
      from account_entries e join accounts a on a.id = e.account_id
      where e.business_id = ${c.businessId} and e.entry_date between ${c.from}::date and ${c.to}::date ${when(c.accountId, sql`and e.account_id = ${c.accountId}`)}`,
    orderBy: "entry_date desc, sort_at desc",
  },
];

// ---------------------------------------------------------------- tax

const tax: ReportDef[] = [
  {
    key: "sales-tax-summary", title: "Sales tax summary", group: "Tax", description: "Tax charged on sales, less returns (output), and tax paid on purchases, less returns (input), by rate: what to put on the return.",
    needs: ["reports.tax.view"], filters: ["dates", "branchId"],
    columns: [percent("rate", "Rate"), money("sales_taxable", "Taxable sales"), money("output_tax", "Output tax"), money("purchases_taxable", "Taxable purchases"), money("input_tax", "Input tax"), money("net_tax", "Tax to pay (output less input)")],
    inner: (c) => sql`with
        out_rows as (
          select l.tax_rate_bps as rate, l.taxable_paisa as taxable, l.tax_paisa as tax from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id
            where i.business_id = ${c.businessId} and ${within("i.posted_at", c)} ${when(c.branchId, sql`and i.branch_id = ${c.branchId}`)}
          union all
          select rl.tax_rate_bps, -rl.taxable_paisa, -rl.tax_paisa from sales_return_lines rl join sales_returns r on r.id = rl.return_id
            where r.business_id = ${c.businessId} and ${within("r.posted_at", c)} ${when(c.branchId, sql`and r.branch_id = ${c.branchId}`)}
        ),
        in_rows as (
          select bl.tax_rate_bps as rate, bl.line_value_paisa as taxable, bl.tax_paisa as tax from purchase_bill_lines bl join purchase_bills b on b.id = bl.bill_id
            where b.business_id = ${c.businessId} and b.bill_date between ${c.from}::date and ${c.to}::date ${when(c.branchId, sql`and b.branch_id = ${c.branchId}`)}
          union all
          select prl.tax_rate_bps, -prl.line_value_paisa, -prl.tax_paisa from purchase_return_lines prl join purchase_returns pr on pr.id = prl.return_id
            where pr.business_id = ${c.businessId} and ${within("pr.posted_at", c)} ${when(c.branchId, sql`and pr.branch_id = ${c.branchId}`)}
        ),
        o as (select rate, sum(taxable)::bigint as taxable, sum(tax)::bigint as tax from out_rows group by rate),
        n as (select rate, sum(taxable)::bigint as taxable, sum(tax)::bigint as tax from in_rows group by rate)
      select coalesce(o.rate, n.rate) as rate, coalesce(o.taxable, 0)::bigint as sales_taxable, coalesce(o.tax, 0)::bigint as output_tax,
        coalesce(n.taxable, 0)::bigint as purchases_taxable, coalesce(n.tax, 0)::bigint as input_tax, (coalesce(o.tax, 0) - coalesce(n.tax, 0))::bigint as net_tax
      from o full join n on n.rate = o.rate`,
    orderBy: "rate",
  },
];

export const reportCatalogue: ReportDef[] = [...sellers, ...profits, ...inventory, ...purchasing, ...owed, ...cash, ...tax];
export const reportByKey = new Map(reportCatalogue.map((report) => [report.key, report]));
