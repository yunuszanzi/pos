import { businessToday } from "../../shared/dates";
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteTestStaff, sql, type TestBusiness } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const daysAgo = (days: number) => new Date(Date.parse(businessToday()) - days * 86_400_000).toISOString().slice(0, 10);

// v0.4 slice 4 against the real API and database: statements, ageing and opening balances.

async function setup() {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A");
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,1000,Piece,1.00" }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const as = { terminalId: business.terminalId };
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
  const client = sql();
  const methods = Object.fromEntries((await client<{ id: string; code: string }[]>`SELECT id, code FROM payment_methods WHERE business_id = ${business.businessId}`).map((row) => [row.code, row.id]));
  await client.end();
  return { business, product, as, shiftId: shift.body.id as string, methods };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function newCustomer(business: TestBusiness, name: string, extra: Record<string, unknown> = {}) {
  const created = await callApi(business.ownerToken, "POST", "/customers", { body: { name, creditLimitPaisa: 100_000_000, ...extra } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.id as string;
}

/** Sells `quantity` pieces (Rs 5.00 each) to a customer, paying `paidPaisa` in cash. */
async function sell(context: Setup, customerId: string, quantity: string, paidPaisa: number) {
  const sale = await callApi(context.business.ownerToken, "POST", "/sales", {
    ...context.as, idempotencyKey: key(),
    body: {
      shiftId: context.shiftId, customerId, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity }],
      payments: paidPaisa > 0 ? [{ methodId: context.methods.cash, amountPaisa: paidPaisa }] : [],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  return sale.body.invoice as { id: string; number: string };
}

const statementOf = async (context: Setup, customerId: string, query = "") => callApi(context.business.ownerToken, "GET", `/customers/${customerId}/statement${query}`);
const importBalances = (context: Setup, csv: string, token = context.business.ownerToken) => callApi(token, "POST", "/customers-opening-balances", { body: { csv }, idempotencyKey: key() });

integration("customer statements, ageing and opening balances", { timeout: 180_000 }, () => {
  it("acceptance 3: a month's statement equals invoices − returns − payments", async () => {
    const context = await setup();
    const customerId = await newCustomer(context.business, "Statement Customer");

    // Before this month: an opening balance of Rs 1,000.00 loaded for the last day of last month.
    const lastMonth = new Date(`${businessToday()}T00:00:00Z`);
    lastMonth.setUTCDate(0);
    const imported = await importBalances(context, `customer,balance,date\nStatement Customer,1000.00,${lastMonth.toISOString().slice(0, 10)}\n`);
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);

    const first = await sell(context, customerId, "100", 20_000); // Rs 500.00 bill, Rs 200.00 paid at the till
    await sell(context, customerId, "10", 0); //                      Rs 50.00 on credit
    const payment = await callApi(context.business.ownerToken, "POST", "/customer-payments", {
      ...context.as, idempotencyKey: key(), body: { customerId, methodId: context.methods.cash, amountPaisa: 10_000 },
    });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    const returnable = await callApi(context.business.ownerToken, "GET", `/sales/${first.id}/returnable`);
    const returned = await callApi(context.business.ownerToken, "POST", "/returns", {
      ...context.as, idempotencyKey: key(),
      body: { shiftId: context.shiftId, invoiceId: first.id, lines: [{ originalLineId: returnable.body.lines[0].lineId, quantity: "20", restockTo: "sellable" }], refund: { methodId: context.methods.cash } },
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);

    const khata = await callApi(context.business.ownerToken, "GET", `/customers/${customerId}/ledger`);
    const statement = await statementOf(context, customerId);
    expect(statement.status, JSON.stringify(statement.body)).toBe(200);
    const { summary, entries } = statement.body;
    expect(summary.openingPaisa).toBe(100_000);
    expect(summary.invoicesPaisa).toBe(55_000);
    expect(summary.paymentsPaisa).toBe(30_000); // Rs 200.00 at the till + Rs 100.00 received
    expect(summary.returnsPaisa).toBe(10_000); //  20 pieces at Rs 5.00
    // The statement's closing balance is the khata balance, and the running balance ends on it.
    expect(summary.closingPaisa).toBe(summary.openingPaisa + summary.invoicesPaisa - summary.paymentsPaisa - summary.returnsPaisa + summary.refundsPaisa);
    expect(summary.closingPaisa).toBe(khata.body.customer.balancePaisa);
    expect(entries[entries.length - 1].balanceAfterPaisa).toBe(summary.closingPaisa);
    expect(statement.body.customer.name).toBe("Statement Customer");

    // The period before the invoices holds only the opening balance; one after them is empty and opens with the balance.
    const earlier = await statementOf(context, customerId, `?from=${daysAgo(60)}&to=${lastMonth.toISOString().slice(0, 10)}`);
    expect(earlier.body.entries.map((entry: { docType: string }) => entry.docType)).toEqual(["opening_balance"]);
    expect(earlier.body.summary).toMatchObject({ openingPaisa: 0, otherPaisa: 100_000, closingPaisa: 100_000 });
    const future = await statementOf(context, customerId, `?from=${daysAgo(-5)}&to=${daysAgo(-9)}`);
    expect(future.body.entries).toEqual([]);
    expect(future.body.summary.openingPaisa).toBe(summary.closingPaisa);
  });

  it("rejects bad periods and unknown customers", async () => {
    const context = await setup();
    const customerId = await newCustomer(context.business, "Period Customer");
    expect((await statementOf(context, customerId, "?from=2026-13-01&to=2026-12-01")).status).toBe(400);
    expect((await statementOf(context, customerId, "?from=yesterday")).status).toBe(400);
    expect((await statementOf(context, customerId, `?from=${daysAgo(-9)}&to=${daysAgo(-5)}`)).status).toBe(400); // ends before it starts
    expect((await statementOf(context, "not-an-id")).status).toBe(404);
    expect((await statementOf(context, crypto.randomUUID())).status).toBe(404);
  });

  it("ages what is owed by the date of the debt, oldest paid first", async () => {
    const context = await setup();
    const old = await newCustomer(context.business, "Old Debt", { termsDays: 15 });
    const tidy = await newCustomer(context.business, "Fresh Debt");
    const settled = await newCustomer(context.business, "Settled");
    const imported = await importBalances(context, `customer,balance,date\nOld Debt,800.00,${daysAgo(100)}\nSettled,50.00,${daysAgo(10)}\n`);
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);

    await sell(context, old, "100", 0); //   Rs 500.00, new
    await sell(context, tidy, "20", 0); //   Rs 100.00, new
    await callApi(context.business.ownerToken, "POST", "/customer-payments", { ...context.as, idempotencyKey: key(), body: { customerId: settled, methodId: context.methods.cash, amountPaisa: 5_000 } });

    const report = await callApi(context.business.ownerToken, "GET", "/customer-ageing");
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const byName = Object.fromEntries(report.body.data.map((row: { name: string }) => [row.name, row]));
    expect(byName["Old Debt"]).toMatchObject({ bandsPaisa: [50_000, 0, 0, 80_000], owedPaisa: 130_000, overdue: true });
    expect(byName["Old Debt"].oldestDays).toBeGreaterThanOrEqual(100);
    expect(byName["Fresh Debt"]).toMatchObject({ bandsPaisa: [10_000, 0, 0, 0], overdue: false });
    expect(byName.Settled).toBeUndefined(); // paid in full
    expect(report.body.totals).toEqual({ bandsPaisa: [60_000, 0, 0, 80_000], owedPaisa: 140_000 });
    expect(report.body.data[0].name).toBe("Old Debt"); // biggest debt first

    const overdue = await callApi(context.business.ownerToken, "GET", "/customer-ageing?overdue=true");
    expect(overdue.body.data.map((row: { name: string }) => row.name)).toEqual(["Old Debt"]);
    expect(overdue.body.total).toBe(1);

    // A payment takes the 100-day-old debt first, so the oldest band empties before the fresh one is touched.
    await callApi(context.business.ownerToken, "POST", "/customer-payments", { ...context.as, idempotencyKey: key(), body: { customerId: old, methodId: context.methods.cash, amountPaisa: 90_000 } });
    const after = await callApi(context.business.ownerToken, "GET", "/customer-ageing?q=Old");
    expect(after.body.data).toMatchObject([{ name: "Old Debt", bandsPaisa: [40_000, 0, 0, 0], owedPaisa: 40_000, overdue: false }]);

    const paged = await callApi(context.business.ownerToken, "GET", "/customer-ageing?pageSize=1&page=2");
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.total).toBe(2);
  });

  it("loads opening balances all or nothing, once per customer", async () => {
    const context = await setup();
    const owes = await newCustomer(context.business, "Owes Us", { phone: "0300-1111111" });
    const holds = await newCustomer(context.business, "We Owe Them", { phone: "0311-2222222" });
    await newCustomer(context.business, "Twin");
    await newCustomer(context.business, "Twin");

    const preview = async (csv: string) => callApi(context.business.ownerToken, "POST", "/customers-opening-balances/preview", { body: { csv } });
    const good = "customer,phone,balance,date,note\nOwes Us,,45000.00,,From the old register\n,0311-2222222,-1200.50,,Advance held\n";
    const checked = await preview(good);
    expect(checked.body).toMatchObject({ canImport: true, issues: [], summary: { customers: 2, owedPaisa: 4_500_000, creditPaisa: 120_050 } });

    // One bad row stops the whole file, and nothing is saved.
    const bad = await importBalances(context, `${good}Nobody,,10.00,,\nTwin,,10.00,,\n`);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("IMPORT_HAS_ERRORS");
    expect(bad.body.error.details.map((issue: { row: number }) => issue.row)).toEqual([4, 5]);
    expect((await callApi(context.business.ownerToken, "GET", `/customers/${owes}/ledger`)).body.customer.balancePaisa).toBe(0);

    const done = await callApi(context.business.ownerToken, "POST", "/customers-opening-balances", { body: { csv: good }, idempotencyKey: key() });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toEqual({ customers: 2, owedPaisa: 4_500_000, creditPaisa: 120_050 });

    const owesLedger = (await callApi(context.business.ownerToken, "GET", `/customers/${owes}/ledger`)).body;
    expect(owesLedger.customer.balancePaisa).toBe(4_500_000);
    expect(owesLedger.entries).toMatchObject([{ docType: "opening_balance", memo: "From the old register", debitPaisa: 4_500_000, creditPaisa: 0 }]);
    const holdsLedger = (await callApi(context.business.ownerToken, "GET", `/customers/${holds}/ledger`)).body;
    expect(holdsLedger.customer.balancePaisa).toBe(-120_050);

    // It is a starting point: a second load for the same customers is refused, and a customer with a sale cannot take one.
    const again = await importBalances(context, good);
    expect(again.status).toBe(422);
    expect(again.body.error.details[0].message).toMatch(/already has entries/);

    // The same request key replays the first answer instead of loading twice.
    const key1 = key();
    const sold = await newCustomer(context.business, "Fresh");
    const replayCsv = "customer,balance\nFresh,10.00\n";
    const first = await callApi(context.business.ownerToken, "POST", "/customers-opening-balances", { body: { csv: replayCsv }, idempotencyKey: key1 });
    const replay = await callApi(context.business.ownerToken, "POST", "/customers-opening-balances", { body: { csv: replayCsv }, idempotencyKey: key1 });
    expect(first.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replay")).toBe("true");
    expect((await callApi(context.business.ownerToken, "GET", `/customers/${sold}/ledger`)).body.entries).toHaveLength(1);
  });

  it("refuses an opening balance for a customer who has traded", async () => {
    const context = await setup();
    const customerId = await newCustomer(context.business, "Already Trading");
    await sell(context, customerId, "10", 5_000);
    const result = await importBalances(context, "customer,balance\nAlready Trading,100.00\n");
    expect(result.status).toBe(422);
    expect(result.body.error.details[0]).toMatchObject({ row: 2, field: "customer" });
  });

  it("limits statements, ageing and opening balances to people who may see or manage the khata", async () => {
    const context = await setup();
    const customerId = await newCustomer(context.business, "Guarded");
    const cashier = await inviteTestStaff(context.business, "Cashier");
    // A cashier sees the khata but may not load balances.
    expect((await importBalances(context, "customer,balance\nGuarded,1.00\n", cashier.token)).status).toBe(403);
    expect((await callApi(cashier.token, "GET", `/customers/${customerId}/statement`)).status).toBe(200);
    expect((await callApi(cashier.token, "POST", "/customers-opening-balances/preview", { body: { csv: "customer,balance\nGuarded,1.00\n" } })).status).toBe(403);
    const nobody = await callApi("", "GET", "/customer-ageing");
    expect(nobody.status).toBe(401);
  });
});
