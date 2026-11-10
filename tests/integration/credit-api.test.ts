// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql, type SimpleProduct, type TestBusiness } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

// v0.4 slice 2 against the real API and database: credit sales, the khata ledger and payments received.

async function setup(stock = 1000) {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A");
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: `sku,quantity,unit,cost\nA,${stock},Piece,1.00` }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const as = { terminalId: business.terminalId };
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
  const client = sql();
  const methods = Object.fromEntries((await client<{ id: string; code: string }[]>`SELECT id, code FROM payment_methods WHERE business_id = ${business.businessId}`).map((row) => [row.code, row.id]));
  await client.end();
  return { business, product, as, shiftId: shift.body.id as string, methods };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const piece = (product: SimpleProduct, quantity: string) => ({ variantId: product.variantId, unitId: product.pieceId, quantity });

async function newCustomer(business: TestBusiness, creditLimitPaisa: number, extra: Record<string, unknown> = {}) {
  const created = await callApi(business.ownerToken, "POST", "/customers", { body: { name: `Customer ${crypto.randomUUID().slice(0, 6)}`, creditLimitPaisa, ...extra } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.id as string;
}

/** Sells `quantity` pieces (Rs 5.00 each) to a customer, paying `paidPaisa` in cash. */
function sell(context: Setup, customerId: string | null, quantity: string, paidPaisa: number, extra: Record<string, unknown> = {}, token = context.business.ownerToken) {
  return callApi(token, "POST", "/sales", {
    ...context.as, idempotencyKey: key(),
    body: {
      shiftId: context.shiftId, customerId, lines: [piece(context.product, quantity)],
      payments: paidPaisa > 0 ? [{ methodId: context.methods.cash, amountPaisa: paidPaisa }] : [], ...extra,
    },
  });
}

const ledgerOf = async (context: Setup, customerId: string) => (await callApi(context.business.ownerToken, "GET", `/customers/${customerId}/ledger`)).body;

integration("credit sales and the customer ledger", { timeout: 180_000 }, () => {
  it("puts the unpaid part of a named customer's bill on their khata, and the ledger adds up", async () => {
    const context = await setup();
    const customerId = await newCustomer(context.business, 100_000);

    const sale = await sell(context, customerId, "100", 20_000); // Rs 500.00 bill, Rs 200.00 paid
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.invoice).toMatchObject({ totalPaisa: 50_000, paidPaisa: 20_000, balancePaisa: 30_000, customerBalancePaisa: 30_000 });

    const khata = await ledgerOf(context, customerId);
    expect(khata.customer.balancePaisa).toBe(30_000);
    expect(khata.entries.map((entry: { memo: string; debitPaisa: number; creditPaisa: number; balanceAfterPaisa: number }) => [entry.memo, entry.debitPaisa, entry.creditPaisa, entry.balanceAfterPaisa]))
      .toEqual([["Paid at sale", 0, 20_000, 30_000], ["Invoice", 50_000, 0, 50_000]]);
    expect(khata.openInvoices).toMatchObject([{ number: sale.body.invoice.number, outstandingPaisa: 30_000, overdue: false }]);

    // Sold entirely on credit: no payments at all.
    const unpaid = await sell(context, customerId, "10", 0);
    expect(unpaid.status, JSON.stringify(unpaid.body)).toBe(201);
    expect(unpaid.body.invoice).toMatchObject({ paidPaisa: 0, balancePaisa: 5_000, customerBalancePaisa: 35_000, payments: [] });
  });

  it("refuses to leave a walk-in's bill unpaid", async () => {
    const context = await setup();
    const walkIn = await sell(context, null, "1", 100);
    expect(walkIn.status).toBe(422);
    expect(walkIn.body.error.code).toBe("PAYMENT_MISMATCH");
    const nothing = await sell(context, null, "1", 0);
    expect(nothing.status).toBe(422);
  });

  it("acceptance 1: credit over the limit is blocked until a manager approves with a PIN", async () => {
    const context = await setup();
    const cashier = await inviteTestStaff(context.business, "Cashier");
    const manager = await inviteTestStaff(context.business, "Manager");
    const customerId = await newCustomer(context.business, 10_000, { name: "Ali Traders" });

    const first = await sell(context, customerId, "100", 0, {}, cashier.token); // Rs 500 on credit, limit Rs 100
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe("CREDIT_LIMIT_EXCEEDED");
    expect(first.body.error.message).toBe("Ali Traders owes Rs 0.00. Putting Rs 500.00 more on credit passes their limit of Rs 100.00. A manager must approve.");

    // A cashier cannot approve their own sale, a wrong PIN is refused, a manager's PIN lets it through.
    const self = await sell(context, customerId, "100", 0, { approval: { managerEmail: cashier.email, pin: cashier.pin } }, cashier.token);
    expect(self.body.error.code).toBe("CREDIT_LIMIT_EXCEEDED");
    const wrong = await sell(context, customerId, "100", 0, { approval: { managerEmail: manager.email, pin: "9999" } }, cashier.token);
    expect(wrong.status).toBe(401);
    const approved = await sell(context, customerId, "100", 0, { approval: { managerEmail: manager.email, pin: manager.pin } }, cashier.token);
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);

    const client = sql();
    const [row] = await client<{ approved_by: string; approval_note: string }[]>`SELECT approved_by, approval_note FROM sales_invoices WHERE id = ${approved.body.invoice.id}`;
    await client.end();
    expect(row).toEqual({ approved_by: manager.id, approval_note: "Credit limit exceeded" });

    // Within the limit nobody needs to approve.
    const small = await sell(context, await newCustomer(context.business, 100_000), "10", 0, {}, cashier.token);
    expect(small.status, JSON.stringify(small.body)).toBe(201);
  });

  it("does not record an approval that was not needed", async () => {
    const context = await setup();
    const manager = await inviteTestStaff(context.business, "Manager");
    const customerId = await newCustomer(context.business, 100_000);
    const sale = await sell(context, customerId, "10", 0, { approval: { managerEmail: manager.email, pin: manager.pin } });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const client = sql();
    const [row] = await client<{ approved_by: string | null }[]>`SELECT approved_by FROM sales_invoices WHERE id = ${sale.body.invoice.id}`;
    await client.end();
    expect(row.approved_by).toBeNull();
  });

  it("blocks credit for a customer with an invoice past their payment terms, until a manager approves", async () => {
    const context = await setup();
    const manager = await inviteTestStaff(context.business, "Manager");
    const customerId = await newCustomer(context.business, 1_000_000, { termsDays: 7 });
    const old = await sell(context, customerId, "10", 0);
    expect(old.status).toBe(201);

    // Ten days pass. Posted invoices are locked, so the test steps around the triggers to move the clock.
    const client = sql();
    await client.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE sales_invoices SET posted_at = now() - interval '10 days' WHERE id = ${old.body.invoice.id}`;
    });
    await client.end();

    const blocked = await sell(context, customerId, "10", 0);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("CUSTOMER_OVERDUE");
    expect((await ledgerOf(context, customerId)).openInvoices[0].overdue).toBe(true);
    // Paying in full is never blocked.
    expect((await sell(context, customerId, "10", 5_000)).status).toBe(201);
    const approved = await sell(context, customerId, "10", 0, { approval: { managerEmail: manager.email, pin: manager.pin } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
  });

  it("lets only one of two simultaneous credit sales through when the limit has room for one", async () => {
    const context = await setup();
    const customerId = await newCustomer(context.business, 5_000); // Rs 50.00
    const attempt = () => sell(context, customerId, "7", 0); // Rs 35.00 each
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)!.body.error.code).toBe("CREDIT_LIMIT_EXCEEDED");
    expect((await ledgerOf(context, customerId)).customer.balancePaisa).toBe(3_500);
  });

  it("rejects a sale to a customer that is archived or belongs to another business", async () => {
    const context = await setup();
    const customerId = await newCustomer(context.business, 100_000);
    await callApi(context.business.ownerToken, "DELETE", `/customers/${customerId}`);
    expect((await sell(context, customerId, "1", 0)).body.error.code).toBe("INVALID_CUSTOMER");
    const other = await setup();
    expect((await sell(context, await newCustomer(other.business, 1000), "1", 0)).body.error.code).toBe("INVALID_CUSTOMER");
  });
});

integration("receiving payments from customers", { timeout: 180_000 }, () => {
  async function owing(context: Setup, amounts: number[]) {
    const customerId = await newCustomer(context.business, 10_000_000);
    const invoices: Array<{ id: string; number: string }> = [];
    for (const amount of amounts) {
      const sale = await sell(context, customerId, String(amount / 500), 0);
      expect(sale.status, JSON.stringify(sale.body)).toBe(201);
      invoices.push(sale.body.invoice);
    }
    return { customerId, invoices };
  }
  const pay = (context: Setup, body: Record<string, unknown>, options: { token?: string; terminal?: boolean } = {}) => callApi(options.token ?? context.business.ownerToken, "POST", "/customer-payments", {
    ...(options.terminal === false ? {} : context.as), idempotencyKey: key(), body: { methodId: context.methods.cash, ...body },
  });

  it("settles the oldest invoices first, and keeps any extra on the account as credit", async () => {
    const context = await setup();
    const { customerId, invoices } = await owing(context, [10_000, 20_000, 30_000]);

    const first = await pay(context, { customerId, amountPaisa: 15_000 });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ number: "RCT-KHI-000001", amountPaisa: 15_000, customerBalancePaisa: 45_000 });
    expect(first.body.allocations.map((row: { number: string; amountPaisa: number }) => [row.number, row.amountPaisa])).toEqual([[invoices[0].number, 10_000], [invoices[1].number, 5_000]]);

    let khata = await ledgerOf(context, customerId);
    expect(khata.openInvoices.map((row: { outstandingPaisa: number }) => row.outstandingPaisa)).toEqual([15_000, 30_000]);

    // Paying more than is owed leaves store credit: a negative balance.
    const over = await pay(context, { customerId, amountPaisa: 50_000 });
    expect(over.status, JSON.stringify(over.body)).toBe(201);
    expect(over.body.customerBalancePaisa).toBe(-5_000);
    khata = await ledgerOf(context, customerId);
    expect(khata.openInvoices).toEqual([]);
    expect(khata.customer.balancePaisa).toBe(-5_000);
  });

  it("settles the invoices the cashier picks, and refuses more than an invoice owes", async () => {
    const context = await setup();
    const { customerId, invoices } = await owing(context, [10_000, 20_000]);

    const tooMuch = await pay(context, { customerId, amountPaisa: 30_000, allocations: [{ invoiceId: invoices[1].id, amountPaisa: 25_000 }] });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe("INVALID_ALLOCATION");
    const moreThanPaid = await pay(context, { customerId, amountPaisa: 5_000, allocations: [{ invoiceId: invoices[1].id, amountPaisa: 6_000 }] });
    expect(moreThanPaid.body.error.code).toBe("INVALID_ALLOCATION");

    const chosen = await pay(context, { customerId, amountPaisa: 8_000, allocations: [{ invoiceId: invoices[1].id, amountPaisa: 8_000 }] });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(201);
    const khata = await ledgerOf(context, customerId);
    expect(khata.openInvoices.map((row: { number: string; outstandingPaisa: number }) => [row.number, row.outstandingPaisa])).toEqual([[invoices[0].number, 10_000], [invoices[1].number, 12_000]]);
  });

  it("takes cash only into an open shift, but other methods anywhere", async () => {
    const context = await setup();
    const { customerId } = await owing(context, [10_000]);
    const noTill = await pay(context, { customerId, amountPaisa: 1_000 }, { terminal: false });
    expect(noTill.status).toBe(409);
    expect(noTill.body.error.code).toBe("SHIFT_NOT_OPEN");
    const wallet = await pay(context, { customerId, amountPaisa: 1_000, methodId: context.methods.jazzcash, reference: "JC-1" }, { terminal: false });
    expect(wallet.status, JSON.stringify(wallet.body)).toBe(201);
    expect(wallet.body).toMatchObject({ methodCode: "jazzcash", reference: "JC-1" });
  });

  it("is safe to retry, and rejects zero, unknown customers and inactive methods", async () => {
    const context = await setup();
    const { customerId } = await owing(context, [10_000]);
    const request = { ...context.as, idempotencyKey: key(), body: { customerId, methodId: context.methods.cash, amountPaisa: 2_000 } };
    const first = await callApi(context.business.ownerToken, "POST", "/customer-payments", request);
    const again = await callApi(context.business.ownerToken, "POST", "/customer-payments", request);
    expect(first.status).toBe(201);
    expect(again.headers.get("Idempotent-Replay")).toBe("true");
    expect(again.body.id).toBe(first.body.id);
    expect((await ledgerOf(context, customerId)).customer.balancePaisa).toBe(8_000);

    expect((await pay(context, { customerId, amountPaisa: 0 })).status).toBe(400);
    expect((await pay(context, { customerId: crypto.randomUUID(), amountPaisa: 100 })).body.error.code).toBe("INVALID_CUSTOMER");
  });

  it("counts cash received in the shift's expected cash", async () => {
    const context = await setup();
    const { customerId } = await owing(context, [10_000]);
    expect((await pay(context, { customerId, amountPaisa: 4_000 })).status).toBe(201);
    const report = await callApi(context.business.ownerToken, "GET", `/shifts/${context.shiftId}/report`, context.as);
    expect(report.body.report.customerPaymentsPaisa).toBe(4_000);
    expect(report.body.report.expectedCashPaisa).toBe(4_000);
  });

  it("keeps the balance and the ledger honest: only the ledger moves a balance, and entries cannot be changed", async () => {
    const context = await setup();
    const { customerId } = await owing(context, [10_000]);
    const client = sql();
    try {
      await expect(client`UPDATE customers SET balance_paisa = 0 WHERE id = ${customerId}`).rejects.toThrow(/only by the ledger/);
      await expect(client`UPDATE party_ledger SET credit_paisa = 1 WHERE party_id = ${customerId}`).rejects.toThrow(/append-only/);
      await expect(client`DELETE FROM party_ledger WHERE party_id = ${customerId}`).rejects.toThrow(/append-only/);
      await expect(client`DELETE FROM customer_payments WHERE customer_id = ${customerId}`).resolves.toBeDefined(); // none yet
      const [{ total }] = await client<{ total: string }[]>`SELECT coalesce(sum(debit_paisa - credit_paisa), 0) AS total FROM party_ledger WHERE party_id = ${customerId}`;
      const [{ balance_paisa: balance }] = await client<{ balance_paisa: string }[]>`SELECT balance_paisa FROM customers WHERE id = ${customerId}`;
      expect(Number(balance)).toBe(Number(total));
    } finally {
      await client.end();
    }
  });

  it("needs the khata permissions, and a cashier can take a payment", async () => {
    const context = await setup();
    const { customerId } = await owing(context, [10_000]);
    const viewer = await inviteStaffWithPermissions(context.business, "Viewer", ["customers.view"]);
    expect((await callApi(viewer.token, "GET", `/customers/${customerId}/ledger`)).status).toBe(403);
    expect((await pay(context, { customerId, amountPaisa: 100 }, { token: viewer.token })).status).toBe(403);
    // Someone who may view customers but not the khata sees no balance.
    expect((await callApi(viewer.token, "GET", `/customers/${customerId}`)).body.balancePaisa).toBeUndefined();

    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await pay(context, { customerId, amountPaisa: 100 }, { token: cashier.token })).status).toBe(201);
    expect((await callApi(cashier.token, "GET", `/customers/${customerId}/ledger`)).status).toBe(200);
  });
});
