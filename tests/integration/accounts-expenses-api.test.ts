// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

// v0.7 slice 1 against the real API and database: accounts, transfers and expenses (FR-CSH-05, FR-CSH-06).

async function setup(withShift = true) {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,100,Piece,1.00" }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const as = { terminalId: business.terminalId };
  const shift = withShift ? await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 100_000 }, idempotencyKey: key() }) : null;
  const client = sql();
  const methods = Object.fromEntries((await client<{ id: string; code: string }[]>`SELECT id, code FROM payment_methods WHERE business_id = ${business.businessId}`).map((row) => [row.code, row.id]));
  await client.end();
  const categories = (await callApi(business.ownerToken, "GET", "/expense-categories")).body.data as Array<{ id: string; name: string }>;
  return { business, product, as, shiftId: shift?.body.id as string | undefined, methods, categories };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const accountsOf = async (context: Setup) => (await callApi(context.business.ownerToken, "GET", "/accounts")).body.data as Array<{ id: string; name: string; kind: string; balancePaisa: number; methods: string[]; active: boolean }>;
const accountNamed = async (context: Setup, name: string) => (await accountsOf(context)).find((account) => account.name === name)!;
const newAccount = async (context: Setup, name: string, kind: string, openingBalancePaisa = 0) => {
  const made = await callApi(context.business.ownerToken, "POST", "/accounts", { body: { name, kind, openingBalancePaisa } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body as { id: string; balancePaisa: number };
};
const spend = (context: Setup, body: Record<string, unknown>, token = context.business.ownerToken) =>
  callApi(token, "POST", "/expenses", { body: { categoryId: context.categories[0].id, ...body }, idempotencyKey: key() });
const xReport = async (context: Setup) => (await callApi(context.business.ownerToken, "GET", `/shifts/${context.shiftId}/report`, context.as ? { terminalId: context.business.terminalId } : {})).body;

integration("accounts and expenses", { timeout: 300_000 }, () => {
  it("gives every non-cash payment method an account, and none to cash", async () => {
    const context = await setup(false);
    const accounts = await accountsOf(context);
    expect(accounts.map((account) => account.name).sort()).toEqual(["Bank transfer", "Card", "Easypaisa", "JazzCash"]);
    expect(accounts.find((account) => account.name === "JazzCash")).toMatchObject({ kind: "wallet", balancePaisa: 0, methods: ["JazzCash"] });
    expect(accounts.find((account) => account.name === "Bank transfer")).toMatchObject({ kind: "bank" });
    // Seeded expense categories.
    expect(context.categories.map((category) => category.name)).toEqual(expect.arrayContaining(["Rent", "Salaries and wages", "Other"]));
  });

  it("money taken or paid by a wallet or bank method lands in its account: sales, customer payments, supplier payments and refunds", async () => {
    const context = await setup();
    const sell = (quantity: string, methodId: string, amount: number) => callApi(context.business.ownerToken, "POST", "/sales", {
      ...context.as, idempotencyKey: key(),
      body: { shiftId: context.shiftId, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity }], payments: [{ methodId, amountPaisa: amount }] },
    });
    const sale = await sell("2", context.methods.jazzcash, 1_000);
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect((await accountNamed(context, "JazzCash")).balancePaisa).toBe(1_000);
    expect((await accountNamed(context, "Easypaisa")).balancePaisa).toBe(0);

    // A customer pays what they owe by bank transfer.
    const customer = (await callApi(context.business.ownerToken, "POST", "/customers", { body: { name: "Bilal", phone: "0301-1111111", creditLimitPaisa: 1_000_000 } })).body;
    const credit = await callApi(context.business.ownerToken, "POST", "/sales", {
      ...context.as, idempotencyKey: key(),
      body: { shiftId: context.shiftId, customerId: customer.id, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "4" }], payments: [] },
    });
    expect(credit.status, JSON.stringify(credit.body)).toBe(201);
    const paid = await callApi(context.business.ownerToken, "POST", "/customer-payments", { idempotencyKey: key(), body: { customerId: customer.id, methodId: context.methods.bank_transfer, amountPaisa: 2_000, reference: "TRF-1" } });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect((await accountNamed(context, "Bank transfer")).balancePaisa).toBe(2_000);

    // The shop pays a supplier from the wallet.
    const supplier = (await callApi(context.business.ownerToken, "POST", "/suppliers", { body: { name: "Karachi Balloon Mills" } })).body;
    const paySupplier = await callApi(context.business.ownerToken, "POST", "/supplier-payments", { idempotencyKey: key(), body: { supplierId: supplier.id, methodId: context.methods.jazzcash, amountPaisa: 300 } });
    expect(paySupplier.status, JSON.stringify(paySupplier.body)).toBe(201);
    expect((await accountNamed(context, "JazzCash")).balancePaisa).toBe(700);

    // A refund by the same wallet goes out of it.
    const client = sql();
    const [{ id: lineId }] = await client<{ id: string }[]>`SELECT l.id FROM sales_invoice_lines l WHERE l.invoice_id = ${sale.body.invoice.id}`;
    await client.end();
    const refund = await callApi(context.business.ownerToken, "POST", "/returns", {
      ...context.as, idempotencyKey: key(),
      body: { shiftId: context.shiftId, invoiceId: sale.body.invoice.id, lines: [{ originalLineId: lineId, quantity: "1", restockTo: "sellable" }], refund: { methodId: context.methods.jazzcash } },
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect((await accountNamed(context, "JazzCash")).balancePaisa).toBe(200);
    // Cash is not an account: the till's drawer handles it.
    expect((await sell("1", context.methods.cash, 500)).status).toBe(201);
    expect((await accountsOf(context)).reduce((sum, account) => sum + account.balancePaisa, 0)).toBe(2_200);
  });

  it("an account is changed only by its entries: opening, deposits and withdrawals, with a running balance, and never directly", async () => {
    const context = await setup(false);
    const bank = await newAccount(context, "HBL Current", "bank", 500_000);
    expect(bank.balancePaisa).toBe(500_000);
    expect((await callApi(context.business.ownerToken, "POST", "/accounts", { body: { name: "hbl current", kind: "bank" } })).status).toBe(409);
    const dep = await callApi(context.business.ownerToken, "POST", `/accounts/${bank.id}/entries`, { body: { direction: "deposit", amountPaisa: 120_000, memo: "Cheque 4471 cleared" }, idempotencyKey: key() });
    expect(dep.status, JSON.stringify(dep.body)).toBe(201);
    expect(dep.body.account.balancePaisa).toBe(620_000);
    const withdraw = await callApi(context.business.ownerToken, "POST", `/accounts/${bank.id}/entries`, { body: { direction: "withdrawal", amountPaisa: 5_000, memo: "Bank charges" }, idempotencyKey: key() });
    expect(withdraw.body.account.balancePaisa).toBe(615_000);
    const entries = (await callApi(context.business.ownerToken, "GET", `/accounts/${bank.id}/entries`)).body;
    expect(entries.data.map((row: { amountPaisa: number; runningPaisa: number }) => [row.amountPaisa, row.runningPaisa])).toEqual([[-5_000, 615_000], [120_000, 620_000], [500_000, 500_000]]);
    expect(entries.total).toBe(3);
    // Needs a memo and a real amount; a future date is refused.
    expect((await callApi(context.business.ownerToken, "POST", `/accounts/${bank.id}/entries`, { body: { direction: "deposit", amountPaisa: 0, memo: "x" }, idempotencyKey: key() })).status).toBe(400);
    expect((await callApi(context.business.ownerToken, "POST", `/accounts/${bank.id}/entries`, { body: { direction: "deposit", amountPaisa: 5, memo: "x", entryDate: "2999-01-01" }, idempotencyKey: key() })).status).toBe(422);

    const client = sql();
    await expect(client`UPDATE accounts SET balance_paisa = 1 WHERE id = ${bank.id}`).rejects.toThrow(/only by its entries/);
    await expect(client`UPDATE account_entries SET amount_paisa = 1 WHERE account_id = ${bank.id}`).rejects.toThrow(/append-only/);
    await expect(client`DELETE FROM account_entries WHERE account_id = ${bank.id}`).rejects.toThrow(/append-only/);
    await client.end();
  });

  it("moves money between accounts, both sides together, and from the register into an account as a bank deposit", async () => {
    const context = await setup();
    const bank = await newAccount(context, "HBL Current", "bank", 100_000);
    const box = await newAccount(context, "Cash box", "cash", 20_000);
    const move = (body: Record<string, unknown>) => callApi(context.business.ownerToken, "POST", "/account-transfers", { body, idempotencyKey: key() });

    const moved = await move({ fromAccountId: box.id, toAccountId: bank.id, amountPaisa: 15_000, memo: "Banked the box" });
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);
    expect(moved.body.transfer.number).toMatch(/^TRF-[A-Z0-9]+-\d{6}$/);
    expect((await accountNamed(context, "Cash box")).balancePaisa).toBe(5_000);
    expect((await accountNamed(context, "HBL Current")).balancePaisa).toBe(115_000);
    expect((await move({ fromAccountId: bank.id, toAccountId: bank.id, amountPaisa: 1 })).status).toBe(422);
    expect((await move({ fromAccountId: bank.id, toAccountId: crypto.randomUUID(), amountPaisa: 1 })).status).toBe(422);
    expect((await move({ toAccountId: bank.id, amountPaisa: 1 })).status).toBe(400);
    expect((await accountNamed(context, "HBL Current")).balancePaisa).toBe(115_000);

    // The day's cash goes to the bank: the drawer pays out (expected cash drops) and the account receives.
    const deposit = await move({ fromShiftId: context.shiftId, toAccountId: bank.id, amountPaisa: 40_000, memo: "Evening deposit" });
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(201);
    expect((await accountNamed(context, "HBL Current")).balancePaisa).toBe(155_000);
    const report = await xReport(context);
    expect(report.report).toMatchObject({ cashOutPaisa: 40_000, expectedCashPaisa: 60_000 });
    const list = await callApi(context.business.ownerToken, "GET", "/account-transfers");
    expect(list.body.total).toBe(2);
    expect(list.body.data.map((row: { from: string }) => row.from).sort()).toEqual(["Cash box", "Register"]);
    const client = sql();
    await expect(client`UPDATE account_transfers SET amount_paisa = 1 WHERE business_id = ${context.business.businessId}`).rejects.toThrow(/cannot be changed/);
    await client.end();
  });

  it("records an expense paid from an account or from the register; the register's shift expects less cash", async () => {
    const context = await setup();
    const bank = await newAccount(context, "HBL Current", "bank", 100_000);
    const rent = context.categories.find((category) => category.name === "Rent")!;

    const fromBank = await spend(context, { categoryId: rent.id, amountPaisa: 30_000, paidFrom: "account", accountId: bank.id, payee: "Landlord", reference: "Chq 12", expenseDate: "2026-11-01" });
    expect(fromBank.status, JSON.stringify(fromBank.body)).toBe(201);
    expect(fromBank.body).toMatchObject({ amountPaisa: 30_000, categoryName: "Rent", paidFrom: "account", accountName: "HBL Current", payee: "Landlord", expenseDate: "2026-11-01", reversed: false });
    expect(fromBank.body.number).toMatch(/^EXP-[A-Z0-9]+-\d{6}$/);
    expect((await accountNamed(context, "HBL Current")).balancePaisa).toBe(70_000);

    const fromTill = await spend(context, { amountPaisa: 2_500, paidFrom: "register", shiftId: context.shiftId, payee: "Chai wala" });
    expect(fromTill.status, JSON.stringify(fromTill.body)).toBe(201);
    expect((await xReport(context)).report).toMatchObject({ cashOutPaisa: 2_500, expectedCashPaisa: 97_500 });

    const list = (await callApi(context.business.ownerToken, "GET", "/expenses")).body;
    expect(list).toMatchObject({ total: 2, spentPaisa: 32_500 });
    expect((await callApi(context.business.ownerToken, "GET", `/expenses?categoryId=${rent.id}`)).body.total).toBe(1);
    expect((await callApi(context.business.ownerToken, "GET", "/expenses?from=2026-11-05")).body.total).toBe(1);
    expect((await callApi(context.business.ownerToken, "GET", "/expenses?q=chai")).body.total).toBe(1);
  });

  it("refuses a bad expense: no amount, a future date, a closed register, an unavailable account or category", async () => {
    const context = await setup();
    const bank = await newAccount(context, "HBL Current", "bank", 100_000);
    expect((await spend(context, { amountPaisa: 0, paidFrom: "account", accountId: bank.id })).status).toBe(400);
    expect((await spend(context, { amountPaisa: 100, paidFrom: "account" })).status).toBe(400);
    expect((await spend(context, { amountPaisa: 100, paidFrom: "account", accountId: bank.id, shiftId: context.shiftId })).status).toBe(400);
    const future = await spend(context, { amountPaisa: 100, paidFrom: "account", accountId: bank.id, expenseDate: "2999-01-01" });
    expect(future.status).toBe(422);
    expect(future.body.error.code).toBe("INVALID_DATE");
    expect((await spend(context, { amountPaisa: 100, paidFrom: "account", accountId: crypto.randomUUID() })).body.error.code).toBe("INVALID_ACCOUNT");
    expect((await spend(context, { categoryId: crypto.randomUUID(), amountPaisa: 100, paidFrom: "account", accountId: bank.id })).body.error.code).toBe("INVALID_CATEGORY");
    // A retired category and a retired account cannot be used.
    await callApi(context.business.ownerToken, "PUT", `/expense-categories/${context.categories[1].id}`, { body: { name: context.categories[1].name, active: false } });
    expect((await spend(context, { categoryId: context.categories[1].id, amountPaisa: 100, paidFrom: "account", accountId: bank.id })).body.error.code).toBe("INVALID_CATEGORY");
    await callApi(context.business.ownerToken, "PUT", `/accounts/${bank.id}`, { body: { name: "HBL Current", active: false } });
    expect((await spend(context, { amountPaisa: 100, paidFrom: "account", accountId: bank.id })).body.error.code).toBe("INVALID_ACCOUNT");
    // The register must be open.
    const counted = await callApi(context.business.ownerToken, "POST", `/shifts/${context.shiftId}/close`, { ...context.as, body: { countedPaisa: 100_000, countedBreakdown: {} }, idempotencyKey: key() });
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    const closed = await spend(context, { amountPaisa: 100, paidFrom: "register", shiftId: context.shiftId });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("SHIFT_NOT_OPEN");
  });

  it("an expense is never edited or deleted; a mistake is reversed once, with a reason, and the money goes back", async () => {
    const context = await setup();
    const bank = await newAccount(context, "HBL Current", "bank", 100_000);
    const paid = (await spend(context, { amountPaisa: 30_000, paidFrom: "account", accountId: bank.id })).body;
    const till = (await spend(context, { amountPaisa: 2_500, paidFrom: "register", shiftId: context.shiftId })).body;

    const client = sql();
    await expect(client`UPDATE expenses SET amount_paisa = 1 WHERE id = ${paid.id}`).rejects.toThrow(/cannot be changed/);
    await expect(client`DELETE FROM expenses WHERE id = ${paid.id}`).rejects.toThrow(/cannot be deleted/);
    await client.end();

    const reverse = (id: string, body: Record<string, unknown>) => callApi(context.business.ownerToken, "POST", `/expenses/${id}/reverse`, { body, idempotencyKey: key() });
    expect((await reverse(paid.id, {})).status).toBe(400); // a reason is required
    const back = await reverse(paid.id, { reason: "Entered twice" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ reversed: true, reversalReason: "Entered twice" });
    expect((await accountNamed(context, "HBL Current")).balancePaisa).toBe(100_000);
    const again = await reverse(paid.id, { reason: "Again" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_REVERSED");

    // A register expense comes back into an open shift as a cash-in.
    expect((await reverse(till.id, { reason: "Wrong day" })).body.error.code).toBe("SHIFT_NOT_OPEN");
    expect((await reverse(till.id, { reason: "Wrong day", shiftId: context.shiftId })).status).toBe(200);
    expect((await xReport(context)).report).toMatchObject({ cashInPaisa: 2_500, cashOutPaisa: 2_500, expectedCashPaisa: 100_000 });
    const list = (await callApi(context.business.ownerToken, "GET", "/expenses")).body;
    expect(list.total).toBe(2);
    expect(list.spentPaisa).toBe(0);
    expect((await callApi(context.business.ownerToken, "GET", "/expenses?reversed=hide")).body.total).toBe(0);
  });

  it("keeps the photo or PDF of a bill in private storage and hands out a short-lived link", async () => {
    const context = await setup(false);
    const bank = await newAccount(context, "HBL Current", "bank", 100_000);
    const expense = (await spend(context, { amountPaisa: 4_000, paidFrom: "account", accountId: bank.id })).body;
    const { app } = await import("../../server/app");
    const upload = async (token: string, id: string, file: File | null) => {
      const form = new FormData();
      if (file) form.set("file", file);
      const response = await app.fetch(new Request(`http://localhost/api/v1/expenses/${id}/attachment`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }));
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    // A 1x1 PNG.
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));

    expect((await callApi(context.business.ownerToken, "GET", `/expenses/${expense.id}/attachment`)).status).toBe(404);
    const stored = await upload(context.business.ownerToken, expense.id, new File([png], "bill.png", { type: "image/png" }));
    expect(stored.status, JSON.stringify(stored.body)).toBe(201);
    expect(stored.body).toMatchObject({ hasAttachment: true, attachmentName: "bill.png" });
    const link = await callApi(context.business.ownerToken, "GET", `/expenses/${expense.id}/attachment`);
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const fetched = await fetch(link.body.url);
    expect(fetched.status).toBe(200);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(png);
    // The file is not public: the bucket path without the signed token gives nothing.
    expect((await fetch(link.body.url.split("?")[0])).status).toBeGreaterThanOrEqual(400);

    // Only photos and PDFs, and not too big.
    expect((await upload(context.business.ownerToken, expense.id, new File(["hello"], "bill.txt", { type: "text/plain" }))).status).toBe(400);
    expect((await upload(context.business.ownerToken, expense.id, null)).status).toBe(400);
    expect((await upload(context.business.ownerToken, expense.id, new File([new Uint8Array(5 * 1024 * 1024 + 1)], "huge.pdf", { type: "application/pdf" }))).status).toBe(413);
    // A new file replaces the old one.
    const replaced = await upload(context.business.ownerToken, expense.id, new File(["%PDF-1.4"], "bill.pdf", { type: "application/pdf" }));
    expect(replaced.body.attachmentName).toBe("bill.pdf");

    // Another business cannot see or attach to it; a reversed expense takes no new file.
    const other = await createTestBusiness();
    expect((await callApi(other.ownerToken, "GET", `/expenses/${expense.id}/attachment`)).status).toBe(404);
    expect((await upload(other.ownerToken, expense.id, new File([png], "x.png", { type: "image/png" }))).status).toBe(404);
    await callApi(context.business.ownerToken, "POST", `/expenses/${expense.id}/reverse`, { body: { reason: "Duplicate" }, idempotencyKey: key() });
    expect((await upload(context.business.ownerToken, expense.id, new File([png], "again.png", { type: "image/png" }))).status).toBe(409);
  });

  it("keeps cashiers out and lets a viewer look but not touch", async () => {
    const context = await setup(false);
    const cashier = await inviteTestStaff(context.business, "Cashier");
    for (const path of ["/accounts", "/expenses", "/expense-categories", "/account-transfers"]) expect((await callApi(cashier.token, "GET", path)).status, path).toBe(403);
    expect((await spend(context, { amountPaisa: 100, paidFrom: "account", accountId: crypto.randomUUID() }, cashier.token)).status).toBe(403);
    const viewer = await inviteStaffWithPermissions(context.business, "Books viewer", ["accounts.view", "expenses.view"]);
    expect((await callApi(viewer.token, "GET", "/accounts")).status).toBe(200);
    expect((await callApi(viewer.token, "GET", "/expenses")).status).toBe(200);
    expect((await callApi(viewer.token, "POST", "/accounts", { body: { name: "X", kind: "cash" } })).status).toBe(403);
    expect((await spend(context, { amountPaisa: 100, paidFrom: "account", accountId: crypto.randomUUID() }, viewer.token)).status).toBe(403);
  });
});
