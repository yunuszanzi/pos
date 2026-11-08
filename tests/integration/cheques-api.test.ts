// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteTestStaff } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

// v0.4 slice 5 against the real API and database: cheques, post-dated ones, and what a bounce does to the khata.

async function setup() {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A");
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,1000,Piece,1.00" }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const as = { terminalId: business.terminalId };
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
  const customer = await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Cheque Customer", creditLimitPaisa: 100_000_000 } });
  expect(customer.status).toBe(201);
  const customerId = customer.body.id as string;
  return { business, product, as, shiftId: shift.body.id as string, customerId };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Sells `quantity` pieces (Rs 5.00 each) on credit. */
async function sellOnCredit(context: Setup, quantity: string) {
  const sale = await callApi(context.business.ownerToken, "POST", "/sales", {
    ...context.as, idempotencyKey: key(),
    body: { shiftId: context.shiftId, customerId: context.customerId, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity }], payments: [] },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  return sale.body.invoice as { id: string; number: string };
}

const takeCheque = (context: Setup, extra: Record<string, unknown> = {}, token = context.business.ownerToken, idempotencyKey = key()) =>
  callApi(token, "POST", "/cheques", {
    ...context.as, idempotencyKey,
    body: { customerId: context.customerId, chequeNo: `CH-${crypto.randomUUID().slice(0, 6)}`, bank: "HBL", amountPaisa: 30_000, chequeDate: daysFromNow(10), ...extra },
  });
const move = (context: Setup, id: string, action: string, body?: Record<string, unknown>, token = context.business.ownerToken) =>
  callApi(token, "POST", `/cheques/${id}/${action}`, { ...context.as, idempotencyKey: key(), body: body ?? {} });
const ledgerOf = async (context: Setup) => (await callApi(context.business.ownerToken, "GET", `/customers/${context.customerId}/ledger`)).body;

integration("customer cheques", { timeout: 180_000 }, () => {
  it("takes a post-dated cheque as a payment now, and carries it to cleared", async () => {
    const context = await setup();
    const invoice = await sellOnCredit(context, "100"); // Rs 500.00 owed

    const taken = await takeCheque(context, { chequeNo: "000123", amountPaisa: 30_000 });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    expect(taken.body).toMatchObject({ chequeNo: "000123", bank: "HBL", amountPaisa: 30_000, status: "received", due: false, customerName: "Cheque Customer" });

    // It is money received: the khata is down and the invoice is partly settled.
    const khata = await ledgerOf(context);
    expect(khata.customer.balancePaisa).toBe(20_000);
    expect(khata.openInvoices).toMatchObject([{ number: invoice.number, outstandingPaisa: 20_000 }]);

    const deposited = await move(context, taken.body.id, "deposit");
    expect(deposited.status, JSON.stringify(deposited.body)).toBe(200);
    expect(deposited.body.status).toBe("deposited");
    expect(deposited.body.depositedAt).not.toBeNull();
    const cleared = await move(context, taken.body.id, "clear");
    expect(cleared.body).toMatchObject({ status: "cleared" });
    expect((await ledgerOf(context)).customer.balancePaisa).toBe(20_000); // clearing changes nothing on the khata

    // A finished cheque cannot be moved again.
    const again = await move(context, taken.body.id, "clear");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("INVALID_TRANSITION");
    expect((await move(context, taken.body.id, "bounce", { reason: "late" })).status).toBe(409);
  });

  it("a bounce puts the amount back on the khata and re-opens the invoice it had settled", async () => {
    const context = await setup();
    const first = await sellOnCredit(context, "40"); //  Rs 200.00
    const second = await sellOnCredit(context, "60"); // Rs 300.00
    const taken = await takeCheque(context, { amountPaisa: 35_000 }); // settles the first fully, the second by Rs 150.00
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    let khata = await ledgerOf(context);
    expect(khata.customer.balancePaisa).toBe(15_000);
    expect(khata.openInvoices).toMatchObject([{ number: second.number, outstandingPaisa: 15_000 }]);

    const noReason = await move(context, taken.body.id, "bounce", { reason: " " });
    expect(noReason.status).toBe(400); // the reason is required before the database is asked
    const bounced = await move(context, taken.body.id, "bounce", { reason: "Insufficient funds" });
    expect(bounced.status, JSON.stringify(bounced.body)).toBe(200);
    expect(bounced.body).toMatchObject({ status: "bounced", bounceReason: "Insufficient funds", customerBalancePaisa: 50_000 });

    khata = await ledgerOf(context);
    expect(khata.customer.balancePaisa).toBe(50_000);
    expect(khata.openInvoices.map((row: { number: string; outstandingPaisa: number }) => [row.number, row.outstandingPaisa])).toEqual([[first.number, 20_000], [second.number, 30_000]]);
    expect(khata.entries[0]).toMatchObject({ docType: "cheque_bounce", memo: "Cheque bounced", debitPaisa: 35_000 });

    // The statement still adds up: the bounced payment is taken back.
    const statement = (await callApi(context.business.ownerToken, "GET", `/customers/${context.customerId}/statement`)).body.summary;
    expect(statement).toMatchObject({ invoicesPaisa: 50_000, paymentsPaisa: 0, closingPaisa: 50_000 });

    // A bounced cheque is final; the customer pays again with a new one.
    expect((await move(context, taken.body.id, "deposit")).status).toBe(409);
    const replacement = await takeCheque(context, { amountPaisa: 50_000 });
    expect(replacement.status, JSON.stringify(replacement.body)).toBe(201);
    expect((await ledgerOf(context)).openInvoices).toEqual([]);
  });

  it("can bounce straight from in hand, and lists what is due", async () => {
    const context = await setup();
    await sellOnCredit(context, "100");
    const overdue = await takeCheque(context, { chequeNo: "OLD-1", chequeDate: daysFromNow(-2), amountPaisa: 10_000 });
    const later = await takeCheque(context, { chequeNo: "LATER-1", chequeDate: daysFromNow(30), amountPaisa: 10_000 });
    expect(overdue.body.due).toBe(true);
    expect(later.body.due).toBe(false);

    const due = await callApi(context.business.ownerToken, "GET", "/cheques?due=true");
    expect(due.body.data.map((row: { chequeNo: string }) => row.chequeNo)).toEqual(["OLD-1"]);
    const inHand = await callApi(context.business.ownerToken, "GET", "/cheques?status=received");
    expect(inHand.body.data.map((row: { chequeNo: string }) => row.chequeNo)).toEqual(["OLD-1", "LATER-1"]); // soonest first
    const search = await callApi(context.business.ownerToken, "GET", "/cheques?q=later");
    expect(search.body).toMatchObject({ total: 1, data: [{ chequeNo: "LATER-1" }] });
    const paged = await callApi(context.business.ownerToken, "GET", "/cheques?pageSize=1&page=2");
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.total).toBe(2);

    expect((await move(context, later.body.id, "bounce", { reason: "Account closed" })).body.status).toBe("bounced");
    expect((await callApi(context.business.ownerToken, "GET", "/cheques?status=bounced")).body.total).toBe(1);
  });

  it("refuses the same cheque twice, replays a retried request, and checks permissions", async () => {
    const context = await setup();
    const requestKey = key();
    const first = await takeCheque(context, { chequeNo: "777", bank: "Meezan" }, undefined, requestKey);
    const replay = await takeCheque(context, { chequeNo: "777", bank: "Meezan" }, undefined, requestKey);
    expect(first.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replay")).toBe("true");
    expect(replay.body.id).toBe(first.body.id);
    expect((await ledgerOf(context)).customer.balancePaisa).toBe(-30_000); // taken once: store credit, nothing was owed

    const duplicate = await takeCheque(context, { chequeNo: " 777 ", bank: "meezan " });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("CHEQUE_EXISTS");

    // The cashier may take a cheque but not deposit, clear or bounce one.
    const cashier = await inviteTestStaff(context.business, "Cashier");
    const byCashier = await takeCheque(context, { chequeNo: "888" }, cashier.token);
    expect(byCashier.status, JSON.stringify(byCashier.body)).toBe(201);
    expect((await move(context, byCashier.body.id, "deposit", {}, cashier.token)).status).toBe(403);
    expect((await callApi(cashier.token, "GET", "/cheques")).status).toBe(200);
    expect((await callApi("", "GET", "/cheques")).status).toBe(401);

    expect((await takeCheque(context, { customerId: crypto.randomUUID(), chequeNo: "999" })).status).toBe(422);
    expect((await takeCheque(context, { chequeDate: "2026-02-30", chequeNo: "1000" })).status).toBe(400);
    expect((await callApi(context.business.ownerToken, "GET", "/cheques/not-an-id")).status).toBe(404);
    expect((await move(context, crypto.randomUUID(), "deposit")).status).toBe(404);
  });
});
