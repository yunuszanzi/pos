// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql, type TestBusiness } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

// v0.4 slice 3 against the real API and database: returns, refunds, credit notes and the stock and khata that follow them.

async function setup(productExtra: Record<string, unknown> = {}) {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100, productExtra);
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,5000,Piece,1.00" }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const as = { terminalId: business.terminalId };
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
  const client = sql();
  const methods = Object.fromEntries((await client<{ id: string; code: string }[]>`SELECT id, code FROM payment_methods WHERE business_id = ${business.businessId}`).map((row) => [row.code, row.id]));
  await client.end();
  return { business, product, as, shiftId: shift.body.id as string, methods };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function newCustomer(business: TestBusiness, creditLimitPaisa = 10_000_000) {
  const created = await callApi(business.ownerToken, "POST", "/customers", { body: { name: `Customer ${crypto.randomUUID().slice(0, 6)}`, creditLimitPaisa } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.id as string;
}

type Sale = { customerId?: string | null; unit: "pieceId" | "cartonId" | "packId"; quantity: string; paid?: number | "all"; extra?: Record<string, unknown> };

async function sell(context: Setup, sale: Sale) {
  const unitId = context.product[sale.unit];
  const lines = [{ variantId: context.product.variantId, unitId, quantity: sale.quantity }];
  const paid = sale.paid ?? "all";
  const body = (payments: unknown[]) => ({ shiftId: context.shiftId, customerId: sale.customerId ?? null, lines, payments, ...sale.extra });
  if (paid === "all") {
    // Pay generously in cash; cash may be over-tendered and the change is given back.
    const first = await callApi(context.business.ownerToken, "POST", "/sales", { ...context.as, idempotencyKey: key(), body: body([{ methodId: context.methods.cash, amountPaisa: 100_000_000 }]) });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    return first.body.invoice;
  }
  const posted = await callApi(context.business.ownerToken, "POST", "/sales", {
    ...context.as, idempotencyKey: key(), body: body(paid > 0 ? [{ methodId: context.methods.cash, amountPaisa: paid }] : []),
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(201);
  return posted.body.invoice;
}

const giveBack = (context: Setup, invoiceId: string, lines: Array<{ originalLineId: string; quantity: string; restockTo?: string }>, rest: Record<string, unknown> = {}, token = context.business.ownerToken) =>
  callApi(token, "POST", "/returns", {
    ...context.as, idempotencyKey: key(),
    body: {
      shiftId: context.shiftId, invoiceId, lines: lines.map((line) => ({ restockTo: "sellable", ...line })),
      refund: { methodId: context.methods.cash }, ...rest,
    },
  });

const onHand = async (context: Setup) => {
  const client = sql();
  const [row] = await client<{ on_hand: string }[]>`SELECT coalesce(sum(on_hand), 0)::text AS on_hand FROM stock_balances WHERE business_id = ${context.business.businessId} AND variant_id = ${context.product.variantId}`;
  await client.end();
  return row.on_hand;
};

integration("sales returns", { timeout: 180_000 }, () => {
  it("acceptance 2: returning 3 of 10 cartons restocks 3 cartons, reverses discount and tax in proportion and reduces the khata", async () => {
    const context = await setup();
    const tax = await callApi(context.business.ownerToken, "POST", "/tax-categories", { body: { name: "GST 18%", kind: "standard", rateBps: 1800 } });
    expect(tax.status, JSON.stringify(tax.body)).toBe(201);
    const taxed = await callApi(context.business.ownerToken, "POST", "/products", {
      body: {
        name: "Taxed goods", baseUnitId: context.product.pieceId, taxCategoryId: tax.body.id,
        variants: [{ sku: "T", costPaisa: 100, reorderLevel: "0", units: [
          { unitId: context.product.pieceId, factorToBase: "1", salePricePaisa: 500 },
          { unitId: context.product.cartonId, factorToBase: "200", salePricePaisa: 90000 },
        ] }],
      },
    });
    expect(taxed.status, JSON.stringify(taxed.body)).toBe(201);
    await callApi(context.business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nT,5000,Piece,1.00" }, idempotencyKey: key() });
    const customerId = await newCustomer(context.business);

    // 10 cartons at Rs 900.00 with Rs 100.00 off the bill, tax included in the price, on credit: the customer pays nothing now.
    const sale = await callApi(context.business.ownerToken, "POST", "/sales", {
      ...context.as, idempotencyKey: key(),
      body: {
        shiftId: context.shiftId, customerId, invoiceDiscount: { type: "fixed", paisa: 10_000 }, payments: [],
        lines: [{ variantId: taxed.body.variants[0].id, unitId: context.product.cartonId, quantity: "10" }],
      },
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const invoice = sale.body.invoice;
    expect(invoice.totalPaisa).toBe(890_000);
    const line = invoice.lines[0];
    const stockBefore = (await callApi(context.business.ownerToken, "GET", `/sales/${invoice.id}`)).body;
    expect(stockBefore.balancePaisa).toBe(890_000);

    const back = await giveBack(context, invoice.id, [{ originalLineId: (await lineId(context, invoice.id)), quantity: "3" }], { refund: {} });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    const note = back.body.creditNote;
    // 3/10 of everything: price 270,000, line share of the bill discount 3,000, tax (included) 3/10 of 135,762.71 -> whole paisa.
    expect(note.grossPaisa).toBe(270_000);
    expect(note.invoiceDiscountPaisa).toBe(3_000);
    expect(note.totalPaisa).toBe(267_000);
    expect(note.taxPaisa).toBe(Math.round(line.taxPaisa * 0.3));
    expect(note.lines[0].quantity).toBe("3");
    // Nothing was paid on the invoice, so the whole return reduces what the customer owes; nothing is handed back.
    expect(note).toMatchObject({ refundPaisa: 0, accountCreditPaisa: 267_000, customerBalancePaisa: 890_000 - 267_000 });

    const stock = back.body.stock.find((row: { variantId: string }) => row.variantId === taxed.body.variants[0].id);
    expect(stock.onHand).toBe("3600"); // 5000 - 2000 sold + 600 back
    const khata = (await callApi(context.business.ownerToken, "GET", `/customers/${customerId}/ledger`)).body;
    expect(khata.customer.balancePaisa).toBe(623_000);
    expect(khata.openInvoices).toMatchObject([{ number: invoice.number, outstandingPaisa: 623_000 }]);
    const returnable = (await callApi(context.business.ownerToken, "GET", `/sales/${invoice.id}/returnable`)).body;
    expect(returnable.lines[0]).toMatchObject({ quantity: "10", returnedQuantity: "3", remainingQuantity: "7" });
  });

  it("gives the rest of a line back to the paisa, however it was split", async () => {
    const context = await setup();
    const invoice = await sell(context, { unit: "cartonId", quantity: "3", extra: { invoiceDiscount: { type: "fixed", paisa: 1_001 } } });
    const id = await lineId(context, invoice.id);
    let refunded = 0;
    for (const quantity of ["1", "1.5", "0.5"]) {
      const back = await giveBack(context, invoice.id, [{ originalLineId: id, quantity }]);
      expect(back.status, JSON.stringify(back.body)).toBe(201);
      refunded += back.body.creditNote.totalPaisa;
    }
    expect(refunded).toBe(invoice.totalPaisa);
    expect(await onHand(context)).toBe("5000.000");
  });

  it("refuses more than was sold, even from two tills at once", async () => {
    const context = await setup();
    const invoice = await sell(context, { unit: "packId", quantity: "10" });
    const id = await lineId(context, invoice.id);
    const tooMany = await giveBack(context, invoice.id, [{ originalLineId: id, quantity: "10.001" }]);
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe("RETURN_EXCEEDS_SOLD");

    const results = await Promise.all([6, 6].map(() => giveBack(context, invoice.id, [{ originalLineId: id, quantity: "6" }])));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await onHand(context)).toBe(String(5000 - 100 + 60) + ".000");
  });

  it("refunds cash from the drawer and the shift's expected cash goes down by it", async () => {
    const context = await setup();
    const invoice = await sell(context, { unit: "pieceId", quantity: "10" }); // Rs 50.00 in cash
    const before = (await callApi(context.business.ownerToken, "GET", `/shifts/${context.shiftId}/report`, context.as)).body.report;
    const back = await giveBack(context, invoice.id, [{ originalLineId: await lineId(context, invoice.id), quantity: "4" }]);
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    expect(back.body.creditNote).toMatchObject({ totalPaisa: 2_000, refundPaisa: 2_000, accountCreditPaisa: 0, refundMethodName: "Cash" });
    const after = (await callApi(context.business.ownerToken, "GET", `/shifts/${context.shiftId}/report`, context.as)).body.report;
    expect(after.expectedCashPaisa).toBe(before.expectedCashPaisa - 2_000);
    expect(after).toMatchObject({ returnCount: 1, returnsPaisa: 2_000, refundsCashPaisa: 2_000 });
  });

  it("takes what the customer still owes off first and refunds only the rest", async () => {
    const context = await setup();
    const customerId = await newCustomer(context.business);
    // Rs 100.00 bill, Rs 30.00 paid, Rs 70.00 on the khata.
    const invoice = await sell(context, { customerId, unit: "pieceId", quantity: "20", paid: 3_000 });
    const back = await giveBack(context, invoice.id, [{ originalLineId: await lineId(context, invoice.id), quantity: "20" }]);
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    // All Rs 100.00 comes back: Rs 70.00 clears the debt, Rs 30.00 is paid out in cash.
    expect(back.body.creditNote).toMatchObject({ totalPaisa: 10_000, refundPaisa: 3_000, accountCreditPaisa: 7_000, customerBalancePaisa: 0 });
    const khata = (await callApi(context.business.ownerToken, "GET", `/customers/${customerId}/ledger`)).body;
    expect(khata.customer.balancePaisa).toBe(0);
    expect(khata.openInvoices).toEqual([]);
    expect(khata.entries.map((entry: { memo: string }) => entry.memo)).toEqual(["Refunded", "Return", "Paid at sale", "Invoice"]);
  });

  it("turns a paid invoice's return into store credit that the next sale can use", async () => {
    const context = await setup();
    const customerId = await newCustomer(context.business, 0);
    const invoice = await sell(context, { customerId, unit: "pieceId", quantity: "10" }); // paid in full
    const back = await giveBack(context, invoice.id, [{ originalLineId: await lineId(context, invoice.id), quantity: "10" }], { refund: {} });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    expect(back.body.creditNote).toMatchObject({ refundPaisa: 0, accountCreditPaisa: 5_000, customerBalancePaisa: -5_000 });
    const khata = (await callApi(context.business.ownerToken, "GET", `/customers/${customerId}/ledger`)).body;
    expect(khata.customer.balancePaisa).toBe(-5_000);

    // Spending it: a Rs 30.00 sale on account leaves Rs 20.00 of credit, and needs no credit limit.
    const next = await callApi(context.business.ownerToken, "POST", "/sales", {
      ...context.as, idempotencyKey: key(), body: { shiftId: context.shiftId, customerId, payments: [], lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "6" }] },
    });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body.invoice.customerBalancePaisa).toBe(-2_000);
  });

  it("will not send a walk-in's refund to an account", async () => {
    const context = await setup();
    const invoice = await sell(context, { unit: "pieceId", quantity: "2" });
    const back = await giveBack(context, invoice.id, [{ originalLineId: await lineId(context, invoice.id), quantity: "1" }], { refund: {} });
    expect(back.status).toBe(422);
    expect(back.body.error.code).toBe("INVALID_REFUND");
    expect(await onHand(context)).toBe("4998.000");
  });

  it("puts damaged goods in a damaged location and throws away write-offs", async () => {
    const context = await setup();
    const invoice = await sell(context, { unit: "pieceId", quantity: "10" });
    const id = await lineId(context, invoice.id);
    expect((await giveBack(context, invoice.id, [{ originalLineId: id, quantity: "2", restockTo: "damaged" }])).status).toBe(201);
    expect((await giveBack(context, invoice.id, [{ originalLineId: id, quantity: "3", restockTo: "write_off" }])).status).toBe(201);
    expect((await giveBack(context, invoice.id, [{ originalLineId: id, quantity: "1", restockTo: "sellable" }])).status).toBe(201);

    const client = sql();
    const rows = await client<{ type: string; on_hand: string }[]>`
      SELECT l.type, sum(b.on_hand)::text AS on_hand FROM stock_balances b JOIN locations l ON l.id = b.location_id
      WHERE b.business_id = ${context.business.businessId} AND b.variant_id = ${context.product.variantId} GROUP BY l.type ORDER BY l.type`;
    await client.end();
    // 5000 - 10 sold + 1 back on the shelf; 2 in damaged; the 3 written off went nowhere. All 6 count as returned.
    expect(rows.map((row) => [row.type, Number(row.on_hand)])).toEqual([["damaged", 2], ["store", 4991]]);
    expect((await callApi(context.business.ownerToken, "GET", `/sales/${invoice.id}/returnable`)).body.lines[0].remainingQuantity).toBe("4");
  });

  it("needs a manager's PIN for a return with no receipt, and prices it at today's shelf price", async () => {
    const context = await setup();
    const manager = await inviteTestStaff(context.business, "Manager");
    const noReceipt = (approval?: unknown) => callApi(context.business.ownerToken, "POST", "/returns", {
      ...context.as, idempotencyKey: key(),
      body: { shiftId: context.shiftId, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "4", restockTo: "sellable" }], refund: { methodId: context.methods.cash }, approval },
    });
    const refused = await noReceipt();
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("RETURN_APPROVAL_REQUIRED");
    const wrong = await noReceipt({ managerEmail: manager.email, pin: "0000" });
    expect(wrong.status).toBe(401);

    const approved = await noReceipt({ managerEmail: manager.email, pin: manager.pin });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.creditNote).toMatchObject({ invoiceNumber: null, totalPaisa: 2_000, refundPaisa: 2_000, approved: true, approvalNote: "Returned without a receipt" });
    expect(await onHand(context)).toBe("5004.000");
  });

  it("needs a manager after the return window, and the window is a setting", async () => {
    const context = await setup();
    const manager = await inviteTestStaff(context.business, "Manager");
    const invoice = await sell(context, { unit: "pieceId", quantity: "5" });
    const id = await lineId(context, invoice.id);
    const client = sql();
    await client.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE sales_invoices SET posted_at = now() - interval '15 days' WHERE id = ${invoice.id}`;
    });
    await client.end();
    const late = await giveBack(context, invoice.id, [{ originalLineId: id, quantity: "1" }]);
    expect(late.status).toBe(403);
    expect(late.body.error.code).toBe("RETURN_APPROVAL_REQUIRED");
    expect((await callApi(context.business.ownerToken, "GET", `/sales/${invoice.id}/returnable`)).body).toMatchObject({ outsideWindow: true, windowDays: 14 });

    const ok = await giveBack(context, invoice.id, [{ originalLineId: id, quantity: "1" }], { approval: { managerEmail: manager.email, pin: manager.pin } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.creditNote.approvalNote).toBe("Returned after the 14-day window");

    // A longer window lets it through.
    const settings = await callApi(context.business.ownerToken, "GET", "/settings");
    expect((await callApi(context.business.ownerToken, "PUT", "/settings", { body: { ...settings.body, returnWindowDays: 30 } })).status).toBe(200);
    expect((await giveBack(context, invoice.id, [{ originalLineId: id, quantity: "1" }])).status).toBe(201);
  });

  it("checks permissions, the shift and the invoice, and replays an idempotent return once", async () => {
    const context = await setup();
    const invoice = await sell(context, { unit: "pieceId", quantity: "4" });
    const id = await lineId(context, invoice.id);
    // Someone without sales.return may not take one.
    const viewer = await inviteStaffWithPermissions(context.business, "Viewer", ["catalog.view"]);
    const nobody = await callApi(viewer.token, "POST", "/returns", { ...context.as, idempotencyKey: key(), body: {} });
    expect(nobody.status).toBe(403);

    const other = await callApi(context.business.ownerToken, "POST", "/returns", {
      ...context.as, idempotencyKey: key(),
      body: { shiftId: context.shiftId, invoiceId: crypto.randomUUID(), lines: [{ originalLineId: id, quantity: "1", restockTo: "sellable" }], refund: { methodId: context.methods.cash } },
    });
    expect(other.status).toBe(404);

    const same = key();
    const run = () => callApi(context.business.ownerToken, "POST", "/returns", {
      ...context.as, idempotencyKey: same,
      body: { shiftId: context.shiftId, invoiceId: invoice.id, lines: [{ originalLineId: id, quantity: "1", restockTo: "sellable" }], refund: { methodId: context.methods.cash } },
    });
    const first = await run();
    const replay = await run();
    expect(first.status).toBe(201);
    expect(replay.body.creditNote.number).toBe(first.body.creditNote.number);
    expect(await onHand(context)).toBe("4997.000");

    await callApi(context.business.ownerToken, "POST", `/shifts/${context.shiftId}/close`, { ...context.as, idempotencyKey: key(), body: { countedPaisa: 0, countedBreakdown: {} } });
    const closed = await giveBack(context, invoice.id, [{ originalLineId: id, quantity: "1" }]);
    expect(closed.status).toBe(409);
  });

  it("lists credit notes, reprints one as a duplicate, and keeps the posted documents immutable", async () => {
    const context = await setup();
    const invoice = await sell(context, { unit: "pieceId", quantity: "4" });
    const back = await giveBack(context, invoice.id, [{ originalLineId: await lineId(context, invoice.id), quantity: "1" }]);
    const list = await callApi(context.business.ownerToken, "GET", `/returns?q=${back.body.creditNote.number}`);
    expect(list.body).toMatchObject({ total: 1, data: [{ number: back.body.creditNote.number, invoiceNumber: invoice.number, totalPaisa: 500 }] });
    expect(back.body.creditNote.number).toMatch(/^INV-KHI-R-\d{6}$/);

    const reprint = await callApi(context.business.ownerToken, "POST", `/returns/${back.body.creditNote.id}/reprint`, { body: { format: "a4" } });
    expect(reprint.status).toBe(200);
    expect(reprint.body).toMatchObject({ duplicate: true, reprintNumber: 1 });

    const client = sql();
    await expect(client`UPDATE sales_returns SET total_paisa = 1 WHERE id = ${back.body.creditNote.id}`).rejects.toThrow(/cannot be changed/);
    await expect(client`DELETE FROM sales_return_lines WHERE return_id = ${back.body.creditNote.id}`).rejects.toThrow(/cannot be changed/);
    await client.end();
  });
});

async function lineId(context: Setup, invoiceId: string): Promise<string> {
  const returnable = await callApi(context.business.ownerToken, "GET", `/sales/${invoiceId}/returnable`);
  return returnable.body.lines[0].lineId as string;
}
