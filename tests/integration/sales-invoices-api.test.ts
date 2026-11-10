import { businessToday } from "../../shared/dates";
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const inDays = (days: number) => new Date(Date.parse(businessToday()) + days * 86_400_000).toISOString().slice(0, 10);

// v0.6 slice 5 against the real API and database: back-office invoices on credit with terms, due dates and the buyer's NTN/STRN.

async function setup(stock = 100, customerExtra: Record<string, unknown> = {}) {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  if (stock > 0) {
    const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: `sku,quantity,unit,cost\nA,${stock},Piece,1.00` }, idempotencyKey: key() });
    expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  }
  const customer = await callApi(business.ownerToken, "POST", "/customers", {
    body: { name: "Bilal Wholesale", businessName: "Bilal Traders", phone: "0301-1111111", ntn: "7654321-1", strn: "STRN-9", registered: true, address: "Shop 9, Jodia Bazaar", termsDays: 15, creditLimitPaisa: 10_000_000, ...customerExtra },
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  return { business, product, customerId: customer.body.id as string };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const line = (context: Setup, quantity: string, extra: Record<string, unknown> = {}) => ({ variantId: context.product.variantId, unitId: context.product.pieceId, quantity, ...extra });
const post = (context: Setup, path: string, body: Record<string, unknown> = {}, token = context.business.ownerToken) => callApi(token, "POST", path, { body, idempotencyKey: key() });
const stockOf = async (context: Setup) => (await callApi(context.business.ownerToken, "GET", "/stock?q=A")).body.data[0] as { onHand: string; reserved: string; available: string };
const invoice = (context: Setup, body: Record<string, unknown>, token = context.business.ownerToken) => post(context, "/sales-invoices", body, token);
const placeOrder = async (context: Setup, quantity: string) => {
  const placed = await post(context, "/sales-orders", { customerId: context.customerId, lines: [line(context, quantity)] });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  return placed.body.order as { id: string; lines: Array<{ id: string }> };
};
const deliver = async (context: Setup, orderId: string, quantity?: string, lineId?: string) => {
  const written = await post(context, "/delivery-challans", { orderId, ...(quantity ? { lines: [{ orderLineId: lineId, quantity }] } : {}) });
  expect(written.status, JSON.stringify(written.body)).toBe(201);
  expect((await post(context, `/delivery-challans/${written.body.challan.id}/dispatch`)).status).toBe(200);
};
const balanceOf = async (context: Setup) => {
  const client = sql();
  const [row] = await client<{ balance_paisa: string }[]>`SELECT balance_paisa::text FROM customers WHERE id = ${context.customerId}`;
  await client.end();
  return Number(row.balance_paisa);
};
const ledgerCount = async (context: Setup, docType: string) => {
  const client = sql();
  const [{ count }] = await client<{ count: string }[]>`SELECT count(*)::text AS count FROM stock_ledger WHERE business_id = ${context.business.businessId} AND doc_type = ${docType}`;
  await client.end();
  return Number(count);
};

integration("back-office invoices", { timeout: 300_000 }, () => {
  it("bills what an order has delivered, at the order's prices, with terms, a due date and the buyer's registration", async () => {
    const context = await setup(100);
    const order = await placeOrder(context, "30");
    // Nothing delivered yet: nothing can be billed.
    const early = await invoice(context, { orderId: order.id });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("BILLING_EXCEEDS_DELIVERY");

    await deliver(context, order.id, "12", order.lines[0].id);
    expect(await ledgerCount(context, "sales_invoice")).toBe(0);
    const billed = await invoice(context, { orderId: order.id, customerPo: "PO-77", note: "Thank you" });
    expect(billed.status, JSON.stringify(billed.body)).toBe(201);
    expect(billed.body.invoice).toMatchObject({
      channel: "back_office", orderId: order.id, orderNumber: expect.stringMatching(/^SO-/), totalPaisa: 6_000, paidPaisa: 0, balancePaisa: 6_000, termsDays: 15, dueDate: inDays(15),
      customerPo: "PO-77", buyerName: "Bilal Traders", buyerNtn: "7654321-1", buyerStrn: "STRN-9", buyerAddress: "Shop 9, Jodia Bazaar", terminalName: "",
    });
    expect(billed.body.invoice.number).toMatch(/^INV-[A-Z0-9]+-\d{6}$/);
    // The goods had already left: no second stock movement, and the line carries the cost the challan took them out at.
    expect(await ledgerCount(context, "sales_invoice")).toBe(0);
    expect(billed.body.invoice.lines[0]).toMatchObject({ quantity: "12", unitPricePaisa: 500, costPaisa: 100 });
    expect(await balanceOf(context)).toBe(6_000);
    expect(await stockOf(context)).toMatchObject({ onHand: "88", reserved: "18" });

    // The order shows what was billed; more than was delivered is refused.
    let current = (await callApi(context.business.ownerToken, "GET", `/sales-orders/${order.id}`)).body;
    expect(current.lines[0]).toMatchObject({ invoicedBase: "12", billableBase: "0" });
    expect(current.invoices).toHaveLength(1);
    expect((await invoice(context, { orderId: order.id })).status).toBe(409);
    expect((await invoice(context, { orderId: order.id, picks: [{ lineId: order.lines[0].id, quantity: "1" }] })).body.error.code).toBe("BILLING_EXCEEDS_DELIVERY");

    // The rest is delivered and billed: two invoices add up to the order.
    await deliver(context, order.id);
    const rest = await invoice(context, { orderId: order.id });
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(rest.body.invoice.totalPaisa).toBe(9_000);
    expect(billed.body.invoice.totalPaisa + rest.body.invoice.totalPaisa).toBe(15_000);
    expect(await balanceOf(context)).toBe(15_000);
    current = (await callApi(context.business.ownerToken, "GET", `/sales-orders/${order.id}`)).body;
    expect(current.invoices).toHaveLength(2);
  });

  it("delivered and billed goods cannot simply come back on a challan", async () => {
    const context = await setup(100);
    const order = await placeOrder(context, "10");
    await deliver(context, order.id);
    const challans = (await callApi(context.business.ownerToken, "GET", `/sales-orders/${order.id}`)).body.challans;
    await invoice(context, { orderId: order.id });
    const back = await post(context, `/delivery-challans/${challans[0].id}/return`, { reason: "changed mind" });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe("DELIVERY_BILLED");
  });

  it("is paid later through the khata: payments settle the oldest invoice first, and the list follows", async () => {
    const context = await setup(100);
    const order = await placeOrder(context, "30");
    await deliver(context, order.id, "12", order.lines[0].id);
    const first = (await invoice(context, { orderId: order.id })).body.invoice;
    await deliver(context, order.id);
    const second = (await invoice(context, { orderId: order.id })).body.invoice;
    const client = sql();
    const [{ id: methodId }] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${context.business.businessId} AND kind <> 'cash' AND active ORDER BY sort_order LIMIT 1`;
    await client.end();
    const paid = await post(context, "/customer-payments", { customerId: context.customerId, methodId, amountPaisa: 7_000, reference: "TRF-1" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);

    const open = await callApi(context.business.ownerToken, "GET", "/sales-invoices?status=open");
    expect(open.body.total).toBe(1);
    expect(open.body.data[0]).toMatchObject({ id: second.id, totalPaisa: 9_000, outstandingPaisa: 8_000, overdue: false, dueDate: inDays(15) });
    expect((await callApi(context.business.ownerToken, "GET", "/sales-invoices?status=paid")).body.data.map((row: { id: string }) => row.id)).toEqual([first.id]);
    expect((await callApi(context.business.ownerToken, "GET", "/sales-invoices?status=overdue")).body.total).toBe(0);
    const detail = (await callApi(context.business.ownerToken, "GET", `/sales-invoices/${second.id}`)).body;
    expect(detail).toMatchObject({ outstandingPaisa: 8_000, channel: "back_office" });
    expect(await balanceOf(context)).toBe(8_000);
    expect((await callApi(context.business.ownerToken, "GET", `/sales-invoices?q=bilal`)).body.total).toBe(2);
    // A till-style lookup finds a back-office invoice too (returns and reprints use it).
    expect((await callApi(context.business.ownerToken, "GET", `/sales/${first.id}`)).body).toMatchObject({ id: first.id, channel: "back_office" });
  });

  it("goods on a desk invoice can be taken back at the till: the customer owes less and the stock returns", async () => {
    const context = await setup(100);
    const written = (await invoice(context, { customerId: context.customerId, lines: [line(context, "10")] })).body.invoice;
    expect(await balanceOf(context)).toBe(5_000);
    const as = { terminalId: context.business.terminalId };
    const shift = await callApi(context.business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    const client = sql();
    const [{ id: originalLineId }] = await client<{ id: string }[]>`SELECT id FROM sales_invoice_lines WHERE invoice_id = ${written.id}`;
    await client.end();
    const back = await callApi(context.business.ownerToken, "POST", "/returns", {
      ...as, idempotencyKey: key(),
      body: { shiftId: shift.body.id, invoiceId: written.id, lines: [{ originalLineId, quantity: "4", restockTo: "sellable" }], refund: {} },
    });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    // The 4 pieces were Rs 20.00 on an unpaid invoice: the customer owes that much less, and nothing is handed back.
    expect(await balanceOf(context)).toBe(3_000);
    expect(await stockOf(context)).toMatchObject({ onHand: "94" });
  });

  it("an invoice past its due date reads as overdue", async () => {
    const context = await setup(100);
    const written = await invoice(context, { customerId: context.customerId, lines: [line(context, "5")], termsDays: 0 });
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    expect(written.body.invoice).toMatchObject({ termsDays: 0, dueDate: inDays(0) });
    const client = sql();
    await client.begin(async (tx) => {
      await tx`ALTER TABLE sales_invoices DISABLE TRIGGER sales_invoices_protect`;
      await tx`UPDATE sales_invoices SET due_date = current_date - 3 WHERE id = ${written.body.invoice.id}`;
      await tx`ALTER TABLE sales_invoices ENABLE TRIGGER sales_invoices_protect`;
    });
    await client.end();
    const overdue = await callApi(context.business.ownerToken, "GET", "/sales-invoices?status=overdue");
    expect(overdue.body.total).toBe(1);
    expect(overdue.body.data[0].overdue).toBe(true);
  });

  it("invoices a quotation at the quoted prices, in two parts; the goods leave with each invoice", async () => {
    const context = await setup(100);
    const quote = (await callApi(context.business.ownerToken, "POST", "/quotations", {
      body: { customerId: context.customerId, validUntil: inDays(14), lines: [line(context, "10", { discount: { type: "percent", bps: 1000 } })] },
    })).body;
    await post(context, `/quotations/${quote.id}/send`);
    const client = sql();
    await client`UPDATE product_units SET sale_price_paisa = 900 WHERE variant_id = ${context.product.variantId} AND unit_id = ${context.product.pieceId}`;
    await client.end();

    const part = await invoice(context, { quotationId: quote.id, picks: [{ lineId: quote.lines[0].id, quantity: "4" }] });
    expect(part.status, JSON.stringify(part.body)).toBe(201);
    expect(part.body.invoice).toMatchObject({ quotationId: quote.id, grossPaisa: 2_000, lineDiscountPaisa: 200, totalPaisa: 1_800 });
    expect(await stockOf(context)).toMatchObject({ onHand: "96" });
    expect((await callApi(context.business.ownerToken, "GET", `/quotations/${quote.id}`)).body.status).toBe("sent");
    const rest = await invoice(context, { quotationId: quote.id });
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(part.body.invoice.totalPaisa + rest.body.invoice.totalPaisa).toBe(quote.totalPaisa);
    expect((await callApi(context.business.ownerToken, "GET", `/quotations/${quote.id}`)).body.status).toBe("converted");
    expect(await stockOf(context)).toMatchObject({ onHand: "90" });
    expect((await invoice(context, { quotationId: quote.id })).status).toBe(409);
  });

  it("respects stock held for orders: only what is free can be invoiced straight from lines", async () => {
    const context = await setup(100);
    await placeOrder(context, "90"); // 10 are free
    const refused = await invoice(context, { customerId: context.customerId, lines: [line(context, "11")] });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("STOCK_INSUFFICIENT");
    expect(refused.body.error.message).toMatch(/10 available \(100 on hand, 90 already promised/);
    expect(await ledgerCount(context, "sales_invoice")).toBe(0);
    expect((await invoice(context, { customerId: context.customerId, lines: [line(context, "10")], termsDays: 30 })).body.invoice).toMatchObject({ termsDays: 30, dueDate: inDays(30), totalPaisa: 5_000 });
    expect(await stockOf(context)).toMatchObject({ onHand: "90", reserved: "90", available: "0" });
  });

  it("checks the terms and the credit limit; only someone who may approve credit can go over it", async () => {
    const context = await setup(100, { creditLimitPaisa: 3_000 });
    expect((await invoice(context, { customerId: context.customerId, lines: [line(context, "1")], dueDate: inDays(-2) })).body.error.code).toBe("INVALID_TERMS");
    expect((await invoice(context, { customerId: context.customerId, lines: [line(context, "1")], dueDate: "not a date" })).status).toBe(400);

    // 10 pieces = Rs 50.00, over the Rs 30.00 limit. A writer without the credit permission is refused; the owner may approve.
    const writer = await inviteStaffWithPermissions(context.business, "Invoice writer", ["invoices.view", "invoices.create", "customers.view", "catalog.view", "inventory.view"]);
    const refused = await invoice(context, { customerId: context.customerId, lines: [line(context, "10")] }, writer.token);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("CREDIT_LIMIT_EXCEEDED");
    expect(await balanceOf(context)).toBe(0);
    const within = await invoice(context, { customerId: context.customerId, lines: [line(context, "5")] }, writer.token);
    expect(within.status, JSON.stringify(within.body)).toBe(201);
    const approved = await invoice(context, { customerId: context.customerId, lines: [line(context, "10")] });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const client = sql();
    const [row] = await client<{ approval_note: string | null }[]>`SELECT approval_note FROM sales_invoices WHERE id = ${approved.body.invoice.id}`;
    await client.end();
    expect(row.approval_note).toBe("Credit limit exceeded");
  });

  it("is immutable once posted, needs a source and a customer, and keeps cashiers out", async () => {
    const context = await setup(100);
    expect((await invoice(context, { lines: [line(context, "1")] })).status).toBe(400); // lines without a customer
    expect((await invoice(context, {})).status).toBe(400); // no source
    expect((await invoice(context, { orderId: crypto.randomUUID(), lines: [line(context, "1")], customerId: context.customerId })).status).toBe(400); // two sources
    const written = (await invoice(context, { customerId: context.customerId, lines: [line(context, "2")] })).body.invoice;
    const client = sql();
    await expect(client`UPDATE sales_invoices SET total_paisa = 1 WHERE id = ${written.id}`).rejects.toThrow(/cannot be changed/);
    await expect(client`DELETE FROM sales_invoice_lines WHERE invoice_id = ${written.id}`).rejects.toThrow(/cannot be changed/);
    await client.end();
    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await callApi(cashier.token, "GET", "/sales-invoices")).status).toBe(403);
    expect((await invoice(context, { customerId: context.customerId, lines: [line(context, "1")] }, cashier.token)).status).toBe(403);
  });
});
