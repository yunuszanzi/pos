// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, firstLocationId, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const today = () => new Date().toISOString().slice(0, 10);

// v0.7 slice 2 against the real API and database: the report catalogue (SRS 7.2), its filters, totals, export and who may see profit.

type Row = Record<string, string | number | null>;

/**
 * A small seeded month. Product A sells at Rs 5.00 with no tax and costs Re 1.00; product T sells at Rs 5.00 including 18% tax.
 *   S1 10 x A for cash (Rs 50.00)        S2 4 x A on credit to Bilal (Rs 20.00)        S3 2 x T for cash (Rs 10.00, Rs 1.53 of it tax)
 *   R1 2 x A back from S1, refunded in cash (Rs 10.00)       an expense of Rs 5.00 from a bank account
 *   10 x T bought for Rs 2.00 with 18% input tax (Rs 3.60), after the sales so their cost stays Re 1.00.
 */
async function seed() {
  const business = await createTestBusiness();
  const tax = await callApi(business.ownerToken, "POST", "/tax-categories", { body: { name: "GST 18%", kind: "standard", rateBps: 1800 } });
  expect(tax.status, JSON.stringify(tax.body)).toBe(201);
  const a = await createSimpleProduct(business, "A", 100);
  const t = await createSimpleProduct(business, "T", 100, { taxCategoryId: tax.body.id });
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,1000,Piece,1.00\nT,100,Piece,1.00" }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const as = { terminalId: business.terminalId };
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
  const client = sql();
  const methods = Object.fromEntries((await client<{ id: string; code: string }[]>`SELECT id, code FROM payment_methods WHERE business_id = ${business.businessId}`).map((row) => [row.code, row.id]));
  await client.end();
  const customer = (await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Bilal Wholesale", phone: "0301-1111111", creditLimitPaisa: 1_000_000 } })).body;
  const walkIn = (await callApi(business.ownerToken, "POST", "/customers", { body: { name: "=HYPERLINK(\"http://example.com\")", phone: "0302-2222222", creditLimitPaisa: 1_000_000 } })).body;

  const sell = (product: { variantId: string; pieceId: string }, quantity: string, payments: Array<{ methodId: string; amountPaisa: number }>, customerId?: string) =>
    callApi(business.ownerToken, "POST", "/sales", {
      ...as, idempotencyKey: key(),
      body: { shiftId: shift.body.id, customerId: customerId ?? null, lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity }], payments },
    });
  const s1 = await sell(a, "10", [{ methodId: methods.cash, amountPaisa: 5_000 }], walkIn.id);
  const s2 = await sell(a, "4", [], customer.id);
  const s3 = await sell(t, "2", [{ methodId: methods.cash, amountPaisa: 1_000 }]);
  for (const sale of [s1, s2, s3]) expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  const client2 = sql();
  const [{ id: lineId }] = await client2<{ id: string }[]>`SELECT id FROM sales_invoice_lines WHERE invoice_id = ${s1.body.invoice.id}`;
  await client2.end();
  const back = await callApi(business.ownerToken, "POST", "/returns", {
    ...as, idempotencyKey: key(),
    body: { shiftId: shift.body.id, invoiceId: s1.body.invoice.id, lines: [{ originalLineId: lineId, quantity: "2", restockTo: "sellable" }], refund: { methodId: methods.cash } },
  });
  expect(back.status, JSON.stringify(back.body)).toBe(201);

  const bank = (await callApi(business.ownerToken, "POST", "/accounts", { body: { name: "HBL Current", kind: "bank", openingBalancePaisa: 100_000 } })).body;
  const categories = (await callApi(business.ownerToken, "GET", "/expense-categories")).body.data as Array<{ id: string; name: string }>;
  const spent = await callApi(business.ownerToken, "POST", "/expenses", {
    idempotencyKey: key(), body: { categoryId: categories.find((category) => category.name === "Rent")!.id, amountPaisa: 500, paidFrom: "account", accountId: bank.id },
  });
  expect(spent.status, JSON.stringify(spent.body)).toBe(201);

  const supplier = (await callApi(business.ownerToken, "POST", "/suppliers", { body: { name: "Karachi Balloon Mills", termsDays: 30 } })).body;
  const locationId = await firstLocationId(business);
  const received = await callApi(business.ownerToken, "POST", "/goods-receipts", {
    idempotencyKey: key(), body: { supplierId: supplier.id, locationId, lines: [{ variantId: t.variantId, unitId: t.pieceId, quantity: "10", unitCostPaisa: 200 }] },
  });
  expect(received.status, JSON.stringify(received.body)).toBe(201);
  const bill = await callApi(business.ownerToken, "POST", "/purchase-bills", {
    idempotencyKey: key(), body: {
      supplierId: supplier.id, supplierInvoiceNo: "KBM-77", billDate: today(), note: "", charges: [],
      lines: [{ receiptLineId: received.body.receipt.lines[0].id, quantity: "10", unitCostPaisa: 200, taxRateBps: 1800 }],
    },
  });
  expect(bill.status, JSON.stringify(bill.body)).toBe(201);
  return { business, a, t, customer, walkIn, supplier, shiftId: shift.body.id as string, methods, bank, as };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const run = async (context: Seed, reportKey: string, query = "", token = context.business.ownerToken) =>
  callApi<{ key: string; title: string; columns: Array<{ key: string; label: string; type: string; sum?: boolean }>; rows: Row[]; totals: Record<string, number> | null; total: number; page: number; pageSize: number }>(
    token, "GET", `/report-data/${reportKey}${query ? `?${query}` : ""}`);
const csvOf = async (context: Seed, reportKey: string, query = "", token = context.business.ownerToken) => {
  const { app } = await import("../../server/app");
  const response = await app.fetch(new Request(`http://localhost/api/v1/report-data/${reportKey}?format=csv${query ? `&${query}` : ""}`, { headers: { Authorization: `Bearer ${token}` } }));
  // Decoded by hand: response.text() would drop the byte order mark, which is the very thing a spreadsheet needs to see.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(await response.arrayBuffer()));
  return { status: response.status, text, headers: response.headers };
};

let shared: Promise<Seed> | null = null;
const seeded = () => (shared ??= seed());

integration("the report catalogue", { timeout: 600_000 }, () => {
  it("lists only the reports a person may run, and the owner every group", async () => {
    const context = await seeded();
    const owner = (await callApi(context.business.ownerToken, "GET", "/report-catalogue")).body;
    expect(new Set(owner.data.map((report: { group: string }) => report.group))).toEqual(new Set(["Sales", "Profit", "Inventory", "Purchasing", "Receivables and payables", "Cash", "Tax"]));
    expect(owner.data.length).toBeGreaterThanOrEqual(30);
    expect(owner.today).toBe(today());

    const salesOnly = await inviteStaffWithPermissions(context.business, "Sales viewer", ["reports.sales.view"]);
    const visible = (await callApi(salesOnly.token, "GET", "/report-catalogue")).body.data as Array<{ key: string; group: string }>;
    expect(new Set(visible.map((report) => report.group))).toEqual(new Set(["Sales", "Cash"]));
    expect(visible.some((report) => report.key === "profit-and-loss" || report.key === "stock-valuation")).toBe(false);
    const cashier = await inviteTestStaff(context.business, "Cashier");
    // A cashier can see stock and customer balances (they already may), but no sales, profit, purchasing, cash or tax report.
    const cashierGroups = new Set(((await callApi(cashier.token, "GET", "/report-catalogue")).body.data as Array<{ group: string }>).map((report) => report.group));
    for (const group of ["Sales", "Profit", "Purchasing", "Cash", "Tax"]) expect(cashierGroups.has(group), group).toBe(false);
  });

  it("runs every report in the catalogue without error, with columns that match their rows", async () => {
    const context = await seeded();
    const catalogue = (await callApi(context.business.ownerToken, "GET", "/report-catalogue")).body.data as Array<{ key: string }>;
    for (const report of catalogue) {
      const result = await run(context, report.key);
      expect(result.status, `${report.key}: ${JSON.stringify(result.body)}`).toBe(200);
      expect(result.body.columns.length, report.key).toBeGreaterThan(0);
      for (const row of result.body.rows) expect(Object.keys(row).sort(), report.key).toEqual(result.body.columns.map((column) => column.key).sort());
      const csv = await csvOf(context, report.key);
      expect(csv.status, report.key).toBe(200);
    }
  });

  it("sales reports add up: by day, by product, with returns kept apart", async () => {
    const context = await seeded();
    const day = (await run(context, "sales-summary")).body;
    expect(day.rows).toHaveLength(1);
    expect(day.rows[0]).toMatchObject({ date: today(), bills: 3, gross: 8_000, total: 8_000, credit: 2_000 });
    expect(day.totals).toMatchObject({ bills: 3, total: 8_000 });

    const byProduct = (await run(context, "sales-by-product")).body;
    expect(byProduct.rows.map((row) => [row.name, row.quantity, row.sales])).toEqual([["Product A", "14", 7_000], ["Product T", "2", 1_000]]);
    // The owner also sees cost and profit; profit is sales without tax less cost.
    expect(byProduct.rows[0]).toMatchObject({ cost: 1_400, profit: 5_600 });
    expect(byProduct.rows[1]).toMatchObject({ cost: 200, profit: 647 });
    expect(byProduct.totals).toMatchObject({ sales: 8_000, tax: 153, cost: 1_600, profit: 6_247 });

    const returns = (await run(context, "returns")).body;
    expect(returns.rows).toHaveLength(1);
    expect(returns.rows[0]).toMatchObject({ total: 1_000, refund: 1_000, credit: 0 });
    expect((await run(context, "sales-by-customer")).body.rows.map((row) => [row.name, row.sales])).toEqual([["=HYPERLINK(\"http://example.com\")", 5_000], ["Walk-in", 1_000], ["Bilal Wholesale", 2_000]].sort((x, y) => Number(y[1]) - Number(x[1])));
    expect((await run(context, "sales-by-hour")).body.rows).toHaveLength(1);
    expect((await run(context, "sales-by-terminal")).body.rows[0]).toMatchObject({ name: "Register 1", sales: 8_000 });
    expect((await run(context, "discounts")).body.rows).toHaveLength(0);
  });

  it("acceptance 3: profit and loss is sales less returns, less the cost of goods sold, less expenses", async () => {
    const context = await seeded();
    const lines = (await run(context, "profit-and-loss")).body.rows;
    const amount = (label: string) => lines.find((row) => row.line === label)!.amount;
    // Sales without tax: A 14 x Rs 5.00 = 70.00, T 2 x (Rs 5.00 less its Rs 0.765... of tax) = 8.47. Returns 10.00. Net 68.47.
    expect(amount("Sales (without tax)")).toBe(7_847);
    expect(amount("Less: returns (without tax)")).toBe(-1_000);
    expect(amount("Net sales")).toBe(6_847);
    // 14 A and 2 T at Re 1.00 = 16.00, less the 2 A put back on the shelf = 14.00.
    expect(amount("Cost of goods sold")).toBe(1_400);
    expect(amount("Gross profit")).toBe(5_447);
    expect(amount("Less: expenses")).toBe(500);
    expect(amount("Net profit")).toBe(4_947);
    // And it agrees with the ledgers read directly.
    const client = sql();
    const [direct] = await client<{ sales: string; returns: string; cogs: string; expenses: string }[]>`
      SELECT (SELECT sum(taxable_paisa) FROM sales_invoices WHERE business_id = ${context.business.businessId})::text AS sales,
             (SELECT sum(taxable_paisa) FROM sales_returns WHERE business_id = ${context.business.businessId})::text AS returns,
             ((SELECT sum(round(l.qty_base * l.cost_paisa)) FROM sales_invoice_lines l WHERE l.business_id = ${context.business.businessId})
              - (SELECT sum(round(rl.qty_base * rl.cost_paisa)) FROM sales_return_lines rl WHERE rl.business_id = ${context.business.businessId} AND rl.restock_to = 'sellable'))::text AS cogs,
             (SELECT sum(amount_paisa) FROM expenses WHERE business_id = ${context.business.businessId} AND reversed_at IS NULL)::text AS expenses`;
    await client.end();
    expect(Number(direct.sales) - Number(direct.returns) - Number(direct.cogs) - Number(direct.expenses)).toBe(Number(amount("Net profit")));
    // Reversing the expense changes the result.
    const expense = (await callApi(context.business.ownerToken, "GET", "/expenses")).body.data[0];
    await callApi(context.business.ownerToken, "POST", `/expenses/${expense.id}/reverse`, { body: { reason: "test" }, idempotencyKey: key() });
    expect((await run(context, "profit-and-loss")).body.rows.find((row) => row.line === "Net profit")!.amount).toBe(5_447);
  });

  it("acceptance 2: without the profit permission no report or export shows cost or profit", async () => {
    const context = await seeded();
    const salesOnly = await inviteStaffWithPermissions(context.business, "Sales only", ["reports.sales.view"]);
    const byProduct = await run(context, "sales-by-product", "", salesOnly.token);
    expect(byProduct.status).toBe(200);
    expect(byProduct.body.columns.map((column) => column.key)).toEqual(["name", "quantity", "sales", "tax"]);
    for (const row of byProduct.body.rows) expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["cost"]));
    expect(byProduct.body.totals).toEqual({ sales: 8_000, tax: 153 });
    const csv = await csvOf(context, "sales-by-product", "", salesOnly.token);
    expect(csv.status).toBe(200);
    expect(csv.text).not.toMatch(/Cost|Profit/);
    expect(csv.text.split("\n")[0]).toContain("Sales (with tax)");
    // The profit group, the profit-and-loss and stock valuation refuse them outright, in the table and in the export.
    for (const reportKey of ["profit-by-product", "profit-by-invoice", "profit-and-loss", "stock-valuation", "purchase-register"]) {
      expect((await run(context, reportKey, "", salesOnly.token)).status, reportKey).toBe(403);
      expect((await csvOf(context, reportKey, "", salesOnly.token)).status, reportKey).toBe(403);
    }
    // Someone who may see costs but not profit still cannot see the profit columns.
    const costOnly = await inviteStaffWithPermissions(context.business, "Cost viewer", ["reports.sales.view", "products.cost.view", "inventory.view"]);
    expect((await run(context, "sales-by-product", "", costOnly.token)).body.columns.map((column) => column.key)).not.toContain("profit");
    expect((await run(context, "stock-valuation", "", costOnly.token)).status).toBe(403);
    // A cashier sees nothing at all.
    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await run(context, "sales-summary", "", cashier.token)).status).toBe(403);
    expect((await run(context, "no-such-report")).status).toBe(404);
  });

  it("the sales tax summary gives output tax less input tax by rate", async () => {
    const context = await seeded();
    const result = (await run(context, "sales-tax-summary")).body;
    expect(result.rows.map((row) => [row.rate, row.sales_taxable, row.output_tax, row.purchases_taxable, row.input_tax, row.net_tax])).toEqual([
      [0, 6_000, 0, 0, 0, 0], // A: Rs 70.00 less the Rs 10.00 returned, no tax
      [1_800, 847, 153, 2_000, 360, -207], // T: Rs 1.53 of output tax, Rs 3.60 of input tax
    ]);
    expect(result.totals).toMatchObject({ output_tax: 153, input_tax: 360, net_tax: -207 });
    const salesOnly = await inviteStaffWithPermissions(context.business, "Sales viewer 2", ["reports.sales.view"]);
    expect((await run(context, "sales-tax-summary", "", salesOnly.token)).status).toBe(403);
  });

  it("pages, filters and exports: the register in pages, narrowed by customer and user, and a CSV a spreadsheet can read", async () => {
    const context = await seeded();
    const page1 = (await run(context, "invoice-register", "pageSize=2&page=1")).body;
    const page2 = (await run(context, "invoice-register", "pageSize=2&page=2")).body;
    expect([page1.rows.length, page2.rows.length, page1.total, page2.total]).toEqual([2, 1, 3, 3]);
    expect(new Set([...page1.rows, ...page2.rows].map((row) => row.number)).size).toBe(3);
    expect((await run(context, "invoice-register", `customerId=${context.customer.id}`)).body.rows).toHaveLength(1);
    expect((await run(context, "invoice-register", `userId=${context.business.ownerId}`)).body.total).toBe(3);
    expect((await run(context, "invoice-register", `userId=${crypto.randomUUID()}`)).body.total).toBe(0);
    expect((await run(context, "invoice-register", "q=bilal")).body.total).toBe(1);
    // Outside the dates there is nothing; a backwards or enormous range is refused.
    expect((await run(context, "invoice-register", "from=2020-01-01&to=2020-01-31")).body.total).toBe(0);
    expect((await run(context, "invoice-register", "from=2026-12-31&to=2026-01-01")).status).toBe(400);
    expect((await run(context, "invoice-register", "from=1990-01-01&to=2026-01-01")).status).toBe(400);

    const csv = await csvOf(context, "invoice-register", `customerId=${context.walkIn.id}`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toMatch(/invoice-register-\d{4}-\d{2}-01-to-\d{4}-\d{2}-\d{2}\.csv/);
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.text.slice(1).trim().split(/\r?\n/);
    expect(lines[0]).toBe("Invoice,Date and time,Customer,By,Where,Total,Paid,On credit");
    // Money in plain rupees with two decimals; a customer name that looks like a formula is made harmless.
    expect(lines[1]).toMatch(/^INV-[A-Z0-9]+-\d{6},\d{4}-\d{2}-\d{2} \d{2}:\d{2},"?'=HYPERLINK.*,.*,Register 1,50\.00,50\.00,0\.00$/);
    expect(lines[2]).toMatch(/^Total,,,,,50\.00,50\.00,0\.00$/);
  });

  it("inventory, purchasing, receivables and cash reports", async () => {
    const context = await seeded();
    const stock = (await run(context, "stock-on-hand")).body.rows;
    expect(stock.map((row) => [row.sku, row.on_hand, row.reserved, row.available])).toEqual([["A", "988", "0", "988"], ["T", "108", "0", "108"]]);
    expect((await run(context, "stock-on-hand", `variantId=${context.t.variantId}`)).body.rows).toHaveLength(1);
    const valuation = (await run(context, "stock-valuation")).body;
    expect(valuation.rows[0]).toMatchObject({ sku: "A", avg_cost: 100, value: 98_800 });
    expect(valuation.rows[1]).toMatchObject({ sku: "T", on_hand: "108" });
    expect(valuation.totals?.value).toBe(98_800 + Number(valuation.rows[1].value));
    expect((await run(context, "low-stock")).body.rows).toHaveLength(0);
    expect((await run(context, "dead-stock", "days=30")).body.rows).toHaveLength(0); // both sold today
    expect((await run(context, "stock-movements")).body.total).toBeGreaterThanOrEqual(6);

    const register = (await run(context, "purchase-register")).body;
    expect(register.rows[0]).toMatchObject({ supplier: "Karachi Balloon Mills", supplier_invoice: "KBM-77", subtotal: 2_000, tax: 360, total: 2_360 });
    expect((await run(context, "purchases-by-supplier")).body.rows[0]).toMatchObject({ bills: 1, total: 2_360 });
    expect((await run(context, "grn-not-invoiced")).body.rows).toHaveLength(0);
    expect((await run(context, "pending-purchase-orders")).body.rows).toHaveLength(0);

    const owedByCustomers = (await run(context, "receivables")).body;
    expect(owedByCustomers.rows.map((row) => [row.name, row.balance])).toEqual([["Bilal Wholesale", 2_000]]);
    expect((await run(context, "payables")).body.rows.map((row) => [row.name, row.balance])).toEqual([["Karachi Balloon Mills", 2_360]]);

    const methods = (await run(context, "payments-by-method")).body.rows;
    expect(methods).toEqual([{ method: "Cash", sales: 6_000, receipts: 0, paid_out: 0, refunds: 1_000 }]);
    expect((await run(context, "expenses-by-category")).body.rows.map((row) => [row.category, row.amount])).toEqual([]); // reversed in the P&L test
    const book = (await run(context, "bank-book", `accountId=${context.bank.id}`)).body;
    expect(book.rows.map((row) => [row.kind, row.money_in, row.money_out])).toEqual(expect.arrayContaining([["opening", 100_000, 0], ["expense", 0, 500], ["expense reversal", 500, 0]]));
    expect((await run(context, "shifts")).body.rows[0]).toMatchObject({ terminal: "Register 1", closed: "Still open" });
  });
});
