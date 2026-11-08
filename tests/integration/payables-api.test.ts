// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, firstLocationId, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const today = () => new Date().toISOString().slice(0, 10);

// v0.5 slice 4 against the real API and database: paying suppliers, purchase returns, and the payables that result.

async function setup() {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  const locationId = await firstLocationId(business);
  const client = sql();
  const methods = Object.fromEntries((await client<{ id: string; code: string }[]>`SELECT id, code FROM payment_methods WHERE business_id = ${business.businessId}`).map((row) => [row.code, row.id]));
  await client.end();
  const supplier = await callApi(business.ownerToken, "POST", "/suppliers", { body: { name: "Karachi Balloon Mills", termsDays: 30 } });
  expect(supplier.status).toBe(201);
  return { business, product, locationId, methods, supplierId: supplier.body.id as string };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Receives `quantity` pieces at `costPaisa` each and bills them at `billCostPaisa` (with `taxBps`). Returns the receipt line and the bill. */
async function receiveAndBill(context: Setup, quantity: string, costPaisa: number, billCostPaisa = costPaisa, taxBps = 0) {
  const received = await callApi(context.business.ownerToken, "POST", "/goods-receipts", {
    idempotencyKey: key(),
    body: { supplierId: context.supplierId, locationId: context.locationId, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity, unitCostPaisa: costPaisa }] },
  });
  expect(received.status, JSON.stringify(received.body)).toBe(201);
  const lineId = received.body.receipt.lines[0].id as string;
  const bill = await callApi(context.business.ownerToken, "POST", "/purchase-bills", {
    idempotencyKey: key(),
    body: { supplierId: context.supplierId, supplierInvoiceNo: `INV-${crypto.randomUUID().slice(0, 6)}`, billDate: today(), lines: [{ receiptLineId: lineId, quantity, unitCostPaisa: billCostPaisa, taxRateBps: taxBps }] },
  });
  expect(bill.status, JSON.stringify(bill.body)).toBe(201);
  return { receiptId: received.body.receipt.id as string, lineId, bill: bill.body };
}
const payNow = (context: Setup, body: Record<string, unknown>, options: { token?: string; terminal?: boolean } = {}) =>
  callApi(options.token ?? context.business.ownerToken, "POST", "/supplier-payments", {
    ...(options.terminal ? { terminalId: context.business.terminalId } : {}), idempotencyKey: key(), body: { supplierId: context.supplierId, methodId: context.methods.bank_transfer, ...body },
  });
const supplierOf = async (context: Setup) => (await callApi(context.business.ownerToken, "GET", `/suppliers/${context.supplierId}`)).body;
const openBills = async (context: Setup) => (await callApi(context.business.ownerToken, "GET", `/suppliers/${context.supplierId}/open-bills`)).body as Array<{ billId: string; number: string; outstandingPaisa: number }>;
const returnBody = (receiptId: string, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({ receiptId, reason: "Damaged in transit", lines, ...extra });
const giveBack = (context: Setup, body: Record<string, unknown>, token = context.business.ownerToken) => callApi(token, "POST", "/purchase-returns", { idempotencyKey: key(), body });
const onHand = async (context: Setup) => {
  const client = sql();
  const [row] = await client<{ on_hand: string; avg_cost_paisa: string }[]>`SELECT on_hand::text, avg_cost_paisa::text FROM stock_balances WHERE variant_id = ${context.product.variantId} AND location_id = ${context.locationId}`;
  await client.end();
  return { onHand: row.on_hand, average: Number(row.avg_cost_paisa) };
};

integration("paying suppliers", { timeout: 240_000 }, () => {
  it("settles the oldest bills first, and keeps any extra as an advance", async () => {
    const context = await setup();
    const first = await receiveAndBill(context, "100", 500); //  Rs 500.00
    const second = await receiveAndBill(context, "60", 500); //  Rs 300.00
    expect((await openBills(context)).map((bill) => bill.outstandingPaisa)).toEqual([50_000, 30_000]);
    expect((await supplierOf(context)).balancePaisa).toBe(80_000);

    const paid = await payNow(context, { amountPaisa: 60_000, reference: "TRF-9001" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.number).toMatch(/^SPY-[A-Z0-9]+-\d{6}$/);
    expect(paid.body).toMatchObject({ amountPaisa: 60_000, methodName: "Bank transfer", reference: "TRF-9001", supplierBalancePaisa: 20_000 });
    expect(paid.body.allocations.map((row: { number: string; amountPaisa: number }) => [row.number, row.amountPaisa])).toEqual([[first.bill.number, 50_000], [second.bill.number, 10_000]]);
    expect((await openBills(context)).map((bill) => bill.outstandingPaisa)).toEqual([20_000]);

    // More than is owed: the bills are settled and the rest is an advance, a credit with the supplier.
    const advance = await payNow(context, { amountPaisa: 25_000 });
    expect(advance.body.allocations).toHaveLength(1);
    expect(advance.body.supplierBalancePaisa).toBe(-5_000);
    expect(await openBills(context)).toEqual([]);
    const ledger = (await callApi(context.business.ownerToken, "GET", `/suppliers/${context.supplierId}/ledger`)).body;
    expect(ledger.entries[0]).toMatchObject({ docType: "supplier_payment", debitPaisa: 25_000, balanceAfterPaisa: -5_000 });
    // Credit held is not a debt: nothing is owed in the ageing report.
    expect((await callApi(context.business.ownerToken, "GET", "/supplier-ageing")).body.total).toBe(0);
  });

  it("lets the payer choose which bills a payment settles, and refuses what does not fit", async () => {
    const context = await setup();
    const first = await receiveAndBill(context, "100", 500);
    const second = await receiveAndBill(context, "60", 500);
    const chosen = await payNow(context, { amountPaisa: 10_000, allocations: [{ billId: second.bill.id, amountPaisa: 10_000 }] });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(201);
    expect(chosen.body.allocations).toMatchObject([{ number: second.bill.number, amountPaisa: 10_000 }]);
    expect((await openBills(context)).map((bill) => [bill.number, bill.outstandingPaisa])).toEqual([[first.bill.number, 50_000], [second.bill.number, 20_000]]);

    const tooMuch = await payNow(context, { amountPaisa: 30_000, allocations: [{ billId: second.bill.id, amountPaisa: 30_000 }] });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe("INVALID_ALLOCATION");
    const beyondPayment = await payNow(context, { amountPaisa: 1_000, allocations: [{ billId: first.bill.id, amountPaisa: 2_000 }] });
    expect(beyondPayment.status).toBe(422);
    // Another supplier's bill cannot be settled from here.
    const other = await callApi(context.business.ownerToken, "POST", "/suppliers", { body: { name: "Someone Else" } });
    const theirs = await payNow({ ...context, supplierId: other.body.id }, { amountPaisa: 1_000, allocations: [{ billId: first.bill.id, amountPaisa: 1_000 }] });
    expect(theirs.status).toBe(422);
    expect((await supplierOf(context)).balancePaisa).toBe(70_000); // nothing was recorded by the refused ones
  });

  it("takes cash from the open shift on a terminal, and refuses cash from the back office", async () => {
    const context = await setup();
    await receiveAndBill(context, "100", 500);
    const backOffice = await payNow(context, { methodId: context.methods.cash, amountPaisa: 10_000 });
    expect(backOffice.status).toBe(409);
    expect(backOffice.body.error.code).toBe("SHIFT_NOT_OPEN");
    const noShift = await payNow(context, { methodId: context.methods.cash, amountPaisa: 10_000 }, { terminal: true });
    expect(noShift.status).toBe(409);

    const shift = await callApi(context.business.ownerToken, "POST", "/shifts/open", { terminalId: context.business.terminalId, body: { openingFloatPaisa: 100_000 }, idempotencyKey: key() });
    const cash = await payNow(context, { methodId: context.methods.cash, amountPaisa: 10_000 }, { terminal: true });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    await payNow(context, { amountPaisa: 5_000 }); // a bank transfer does not touch the drawer

    // Only the cash comes out of the drawer.
    const report = (await callApi(context.business.ownerToken, "GET", `/shifts/${shift.body.id}/report`, { terminalId: context.business.terminalId })).body.report;
    expect(report).toMatchObject({ supplierPaymentsCashPaisa: 10_000, expectedCashPaisa: 90_000 });
    expect(report.supplierPaymentsPaisa).toBe(10_000); // the shift's own payment only: the transfer had no shift
  });

  it("replays a retried payment and keeps a posted payment immutable", async () => {
    const context = await setup();
    await receiveAndBill(context, "100", 500);
    const request = { supplierId: context.supplierId, methodId: context.methods.bank_transfer, amountPaisa: 10_000 };
    const requestKey = key();
    const first = await callApi(context.business.ownerToken, "POST", "/supplier-payments", { idempotencyKey: requestKey, body: request });
    const replay = await callApi(context.business.ownerToken, "POST", "/supplier-payments", { idempotencyKey: requestKey, body: request });
    expect(first.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replay")).toBe("true");
    expect(replay.body.id).toBe(first.body.id);
    expect((await supplierOf(context)).balancePaisa).toBe(40_000);

    const list = await callApi(context.business.ownerToken, "GET", "/supplier-payments?q=SPY");
    expect(list.body).toMatchObject({ total: 1, data: [{ id: first.body.id, amountPaisa: 10_000 }] });
    expect((await callApi(context.business.ownerToken, "GET", `/supplier-payments/${first.body.id}`)).body.allocations).toHaveLength(1);
    expect((await callApi(context.business.ownerToken, "GET", "/supplier-payments/not-an-id")).status).toBe(404);
    const client = sql();
    await expect(client`UPDATE supplier_payments SET amount_paisa = 1 WHERE id = ${first.body.id}`).rejects.toThrow(/cannot be changed/);
    await expect(client`DELETE FROM supplier_payment_allocations WHERE source_id = ${first.body.id}`).rejects.toThrow(/cannot be changed/);
    await client.end();
  });

  it("needs the permission to pay, and to see the ledger", async () => {
    const context = await setup();
    await receiveAndBill(context, "10", 500);
    const request = { amountPaisa: 1_000 };
    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await payNow(context, request, { token: cashier.token })).status).toBe(403);
    const viewer = await inviteStaffWithPermissions(context.business, "Ledger viewer", ["suppliers.ledger"]);
    expect((await payNow(context, request, { token: viewer.token })).status).toBe(403);
    expect((await callApi(viewer.token, "GET", `/suppliers/${context.supplierId}/open-bills`)).status).toBe(200);
    const payer = await inviteStaffWithPermissions(context.business, "Payer", ["suppliers.pay", "suppliers.ledger"]);
    expect((await payNow(context, request, { token: payer.token })).status).toBe(201);
    expect((await callApi("", "GET", "/supplier-payments")).status).toBe(401);
    expect((await callApi(viewer.token, "GET", `/suppliers/${crypto.randomUUID()}/open-bills`)).status).toBe(404);
  });
});

integration("returning goods to a supplier", { timeout: 240_000 }, () => {
  it("takes goods out of stock and the credit off the bill, at the billed price and tax", async () => {
    const context = await setup();
    const { receiptId, lineId, bill } = await receiveAndBill(context, "100", 1_000, 1_200, 1_800); // billed Rs 1,200.00 + 18% = Rs 1,416.00
    expect(bill.totalPaisa).toBe(141_600);
    expect(await onHand(context)).toEqual({ onHand: "100.000", average: 1_200 });

    const returnable = await callApi(context.business.ownerToken, "GET", `/goods-receipts/${receiptId}/returnable`);
    expect(returnable.status, JSON.stringify(returnable.body)).toBe(200);
    expect(returnable.body.lines[0]).toMatchObject({ id: lineId, returnableQuantity: "100", onHandBase: "100", defaultUnitCostPaisa: 1_200, defaultTaxRateBps: 1_800 });

    const returned = await giveBack(context, returnBody(receiptId, [{ receiptLineId: lineId, quantity: "30" }]));
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    expect(returned.body.number).toMatch(/^PRT-[A-Z0-9]+-\d{6}$/);
    // 30 pieces at the billed Rs 12.00 = Rs 360.00, plus 18% tax (Rs 64.80) = Rs 424.80.
    expect(returned.body).toMatchObject({ subtotalPaisa: 36_000, taxPaisa: 6_480, totalPaisa: 42_480, settledBillsPaisa: 42_480, onAccountPaisa: 0, supplierBalancePaisa: 99_120, receiptNumber: expect.stringMatching(/^GRN-/) });
    expect(returned.body.lines[0]).toMatchObject({ quantity: "30", unitCostPaisa: 1_200, lineValuePaisa: 36_000, taxRateBps: 1_800, taxPaisa: 6_480 });
    expect(returned.body.allocations).toMatchObject([{ number: bill.number, amountPaisa: 42_480 }]);

    // Stock goes down by 30; the average is not disturbed. The bill's outstanding amount falls by the credit.
    expect(await onHand(context)).toEqual({ onHand: "70.000", average: 1_200 });
    expect((await openBills(context)).map((row) => row.outstandingPaisa)).toEqual([99_120]);
    const bills = await callApi(context.business.ownerToken, "GET", `/purchase-bills/${bill.id}`);
    expect(bills.body).toMatchObject({ settledPaisa: 42_480, outstandingPaisa: 99_120 });
    expect(bills.body.settlements).toMatchObject([{ kind: "purchase_return", number: returned.body.number, amountPaisa: 42_480 }]);
    const ledger = (await callApi(context.business.ownerToken, "GET", `/suppliers/${context.supplierId}/ledger`)).body;
    expect(ledger.entries[0]).toMatchObject({ docType: "purchase_return", memo: "Return", debitPaisa: 42_480 });
    const movements = (await callApi(context.business.ownerToken, "GET", `/stock/ledger?variantId=${context.product.variantId}`)).body.data;
    expect(movements[0]).toMatchObject({ docType: "purchase_return", quantity: "-30" });
  });

  it("limits a return to what was received, not yet returned, and still on hand", async () => {
    const context = await setup();
    const { receiptId, lineId } = await receiveAndBill(context, "100", 1_000);
    expect((await giveBack(context, returnBody(receiptId, [{ receiptLineId: lineId, quantity: "60" }]))).status).toBe(201);
    const over = await giveBack(context, returnBody(receiptId, [{ receiptLineId: lineId, quantity: "41" }]));
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("RETURN_EXCEEDS_RECEIVED");
    expect((await callApi(context.business.ownerToken, "GET", `/goods-receipts/${receiptId}/returnable`)).body.lines[0]).toMatchObject({ returnableQuantity: "40", returnedBase: "60" });

    // Goods already sold cannot go back: sell 30 of the 40 left, then try to return 40.
    const client = sql();
    const [cash] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${context.business.businessId} AND code = 'cash'`;
    await client.end();
    const shift = await callApi(context.business.ownerToken, "POST", "/shifts/open", { terminalId: context.business.terminalId, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
    const sale = await callApi(context.business.ownerToken, "POST", "/sales", {
      terminalId: context.business.terminalId, idempotencyKey: key(),
      body: { shiftId: shift.body.id, customerId: null, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "30" }], payments: [{ methodId: cash.id, amountPaisa: 15_000 }] },
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const gone = await giveBack(context, returnBody(receiptId, [{ receiptLineId: lineId, quantity: "40" }]));
    expect(gone.status).toBe(409);
    expect(gone.body.error.code).toBe("STOCK_INSUFFICIENT");
    expect((await giveBack(context, returnBody(receiptId, [{ receiptLineId: lineId, quantity: "10" }]))).status).toBe(201);
    expect((await onHand(context)).onHand).toBe("0.000");
  });

  it("keeps credit beyond the open bills on the supplier's account, and lets the supplier credit a different price", async () => {
    const context = await setup();
    const { receiptId, lineId, bill } = await receiveAndBill(context, "100", 1_000); // Rs 1,000.00
    expect((await payNow(context, { amountPaisa: 100_000 })).status).toBe(201); // paid in full: nothing open
    expect(await openBills(context)).toEqual([]);

    // The supplier credits Rs 8.00 a piece rather than Rs 10.00 for 20 pieces: Rs 160.00, all of it on account.
    const returned = await giveBack(context, returnBody(receiptId, [{ receiptLineId: lineId, quantity: "20", unitCostPaisa: 800 }]));
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    expect(returned.body).toMatchObject({ totalPaisa: 16_000, settledBillsPaisa: 0, onAccountPaisa: 16_000, supplierBalancePaisa: -16_000, allocations: [] });
    expect((await callApi(context.business.ownerToken, "GET", `/purchase-bills/${bill.id}`)).body.outstandingPaisa).toBe(0);
    // A later bill is paid down by that credit when the next payment is made.
    const next = await receiveAndBill(context, "50", 1_000);
    expect((await supplierOf(context)).balancePaisa).toBe(34_000);
    expect(next.bill.totalPaisa).toBe(50_000);
  });

  it("refuses a bad return and checks permissions", async () => {
    const context = await setup();
    const { receiptId, lineId } = await receiveAndBill(context, "10", 1_000);
    expect((await giveBack(context, returnBody(receiptId, []))).status).toBe(400);
    expect((await giveBack(context, returnBody(receiptId, [{ receiptLineId: lineId, quantity: "abc" }]))).status).toBe(400);
    expect((await giveBack(context, returnBody(receiptId, [{ receiptLineId: crypto.randomUUID(), quantity: "1" }]))).status).toBe(422);
    expect((await giveBack(context, returnBody(receiptId, [{ receiptLineId: lineId, quantity: "1" }, { receiptLineId: lineId, quantity: "1" }]))).status).toBe(422);
    expect((await giveBack(context, returnBody(crypto.randomUUID(), [{ receiptLineId: lineId, quantity: "1" }]))).status).toBe(422);
    expect((await callApi(context.business.ownerToken, "GET", `/goods-receipts/${crypto.randomUUID()}/returnable`)).status).toBe(404);

    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await giveBack(context, returnBody(receiptId, [{ receiptLineId: lineId, quantity: "1" }]), cashier.token)).status).toBe(403);
    const withoutCost = await inviteStaffWithPermissions(context.business, "Keeper", ["purchasing.return", "purchasing.view"]);
    expect((await giveBack(context, returnBody(receiptId, [{ receiptLineId: lineId, quantity: "1" }]), withoutCost.token)).status).toBe(403);
    expect((await callApi(withoutCost.token, "GET", "/purchase-returns")).status).toBe(403);

    // The same key replays; a posted return cannot be changed; the list finds it.
    const body = returnBody(receiptId, [{ receiptLineId: lineId, quantity: "2" }]);
    const requestKey = key();
    const first = await callApi(context.business.ownerToken, "POST", "/purchase-returns", { idempotencyKey: requestKey, body });
    const replay = await callApi(context.business.ownerToken, "POST", "/purchase-returns", { idempotencyKey: requestKey, body });
    expect(first.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replay")).toBe("true");
    expect((await onHand(context)).onHand).toBe("8.000");
    const list = await callApi(context.business.ownerToken, "GET", `/purchase-returns?q=${first.body.number}`);
    expect(list.body).toMatchObject({ total: 1, data: [{ id: first.body.id, totalPaisa: 2_000 }] });
    expect((await callApi(context.business.ownerToken, "GET", `/purchase-returns/${first.body.id}`)).body.lines).toHaveLength(1);
    const client = sql();
    await expect(client`UPDATE purchase_returns SET reason = 'x' WHERE id = ${first.body.id}`).rejects.toThrow(/cannot be changed/);
    await client.end();
  });

  it("acceptance 3: the supplier ledger, the payables ageing and the open bills all equal bills minus payments and returns", async () => {
    const context = await setup();
    const first = await receiveAndBill(context, "100", 1_000, 1_000, 1_800); // Rs 1,000.00 + tax = Rs 1,180.00
    await receiveAndBill(context, "50", 2_000, 2_000, 0); //                      Rs 1,000.00
    expect((await payNow(context, { amountPaisa: 50_000 })).status).toBe(201);
    const returned = await giveBack(context, returnBody(first.receiptId, [{ receiptLineId: first.lineId, quantity: "20" }])); // Rs 200.00 + tax Rs 36.00
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);

    const billed = 118_000 + 100_000;
    const expected = billed - 50_000 - 23_600;
    const supplier = await supplierOf(context);
    const ageing = (await callApi(context.business.ownerToken, "GET", "/supplier-ageing")).body;
    const open = (await openBills(context)).reduce((sum, bill) => sum + bill.outstandingPaisa, 0);
    expect(supplier.balancePaisa).toBe(expected);
    expect(ageing.totals.owedPaisa).toBe(expected);
    expect(open).toBe(expected);
    const ledger = (await callApi(context.business.ownerToken, "GET", `/suppliers/${context.supplierId}/ledger`)).body;
    expect(ledger.entries[0].balanceAfterPaisa).toBe(expected);
  });
});
