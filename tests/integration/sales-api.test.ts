// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteTestStaff, sql, type SimpleProduct, type TestBusiness } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

async function stockUp(business: TestBusiness, sku: string, quantity: number) {
  const response = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: `sku,quantity,unit,cost\n${sku},${quantity},Piece,1.00` }, idempotencyKey: key() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
}

async function setup(skus: Array<[string, number]>) {
  const business = await createTestBusiness();
  const products: Record<string, SimpleProduct> = {};
  for (const [sku, quantity] of skus) {
    products[sku] = await createSimpleProduct(business, sku);
    await stockUp(business, sku, quantity);
  }
  const as = { terminalId: business.terminalId };
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
  const client = sql();
  const methods = Object.fromEntries((await client<{ id: string; code: string }[]>`SELECT id, code FROM payment_methods WHERE business_id = ${business.businessId}`).map((row) => [row.code, row.id]));
  await client.end();
  return { business, products, as, shiftId: shift.body.id as string, methods };
}

const piece = (product: SimpleProduct, quantity: string, extra: Record<string, unknown> = {}) => ({ variantId: product.variantId, unitId: product.pieceId, quantity, ...extra });

integration("sales API", { timeout: 180_000 }, () => {
  it("prices a cart on the server, splits cash and wallet, and returns the invoice and new stock", async () => {
    const { business, products, as, shiftId, methods } = await setup([["A", 100], ["B", 100], ["C", 100], ["D", 100], ["E", 100]]);
    const lines = Object.values(products).map((product) => piece(product, "2")); // 5 x (2 x 5.00) = 50.00
    const sale = await callApi(business.ownerToken, "POST", "/sales", {
      ...as, idempotencyKey: key(),
      body: {
        shiftId, lines, invoiceDiscount: { type: "percent", bps: 500 }, expectedTotalPaisa: 4750,
        payments: [{ methodId: methods.jazzcash, amountPaisa: 2000, reference: "JC-77" }, { methodId: methods.cash, amountPaisa: 3000 }],
      },
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const { invoice, stock } = sale.body;
    expect(invoice).toMatchObject({ number: "INV-KHI-000001", grossPaisa: 5000, invoiceDiscountPaisa: 250, totalPaisa: 4750, paidPaisa: 4750, changePaisa: 250, balancePaisa: 0 });
    expect(invoice.lines).toHaveLength(5);
    expect(invoice.payments.map((payment: { methodCode: string; amountPaisa: number; changePaisa: number }) => [payment.methodCode, payment.amountPaisa, payment.changePaisa]))
      .toEqual([["cash", 2750, 250], ["jazzcash", 2000, 0]]);
    expect(stock).toHaveLength(5);
    expect(stock[0].onHand).toBe("98");
    expect((await callApi(business.ownerToken, "GET", `/sales/${invoice.id}`, as)).body.number).toBe(invoice.number);
  });

  it("double-clicking Pay creates one invoice", async () => {
    const { business, products, as, shiftId, methods } = await setup([["A", 10]]);
    const request = { ...as, idempotencyKey: key(), body: { shiftId, lines: [piece(products.A, "1")], payments: [{ methodId: methods.cash, amountPaisa: 500 }] } };
    const [first, second] = await Promise.all([callApi(business.ownerToken, "POST", "/sales", request), callApi(business.ownerToken, "POST", "/sales", request)]);
    const third = await callApi(business.ownerToken, "POST", "/sales", request);
    expect([first.status, second.status].sort()).toContain(201);
    expect(third.status).toBe(201);
    expect(third.headers.get("Idempotent-Replay")).toBe("true");
    const client = sql();
    const [{ count }] = await client<{ count: string }[]>`SELECT count(*) FROM sales_invoices WHERE business_id = ${business.businessId}`;
    await client.end();
    expect(Number(count)).toBe(1);
  });

  it("lets exactly one of two simultaneous sales of the last unit through", async () => {
    const { business, products, as, shiftId, methods } = await setup([["A", 1]]);
    const attempt = () => callApi(business.ownerToken, "POST", "/sales", {
      ...as, idempotencyKey: key(), body: { shiftId, lines: [piece(products.A, "1")], payments: [{ methodId: methods.cash, amountPaisa: 500 }] },
    });
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)!.body.error.code).toBe("STOCK_INSUFFICIENT");
  });

  it("refuses a changed price without permission, a stale total, and bad payments", async () => {
    const { business, products, as, shiftId, methods } = await setup([["A", 10]]);
    const cashier = await inviteTestStaff(business, "Cashier");
    const sell = (token: string, body: Record<string, unknown>) => callApi(token, "POST", "/sales", {
      ...as, idempotencyKey: key(), body: { shiftId, payments: [{ methodId: methods.cash, amountPaisa: 500 }], lines: [piece(products.A, "1")], ...body },
    });

    expect((await sell(business.ownerToken, { expectedTotalPaisa: 499 })).body.error.code).toBe("TOTAL_CHANGED");
    expect((await sell(business.ownerToken, { payments: [{ methodId: methods.cash, amountPaisa: 100 }] })).body.error.code).toBe("PAYMENT_MISMATCH");
    expect((await sell(business.ownerToken, { payments: [{ methodId: methods.jazzcash, amountPaisa: 900 }] })).body.error.code).toBe("OVERPAID_WITHOUT_CASH");
    expect((await sell(business.ownerToken, { lines: [piece(products.A, "0")] })).status).toBe(400);
    expect((await sell(business.ownerToken, { shiftId: crypto.randomUUID() })).body.error.code).toBe("SHIFT_NOT_OPEN");

    const cheap = { lines: [piece(products.A, "1", { unitPricePaisa: 300 })], payments: [{ methodId: methods.cash, amountPaisa: 300 }] };
    const denied = await sell(cashier.token, cheap);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PRICE_OVERRIDE_DENIED");
    const allowed = await sell(business.ownerToken, cheap);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect(allowed.body.invoice.totalPaisa).toBe(300);
  });

  it("lets a cashier discount up to their limit and needs a manager's PIN above it", async () => {
    const { business, products, as, shiftId, methods } = await setup([["A", 10]]);
    const cashier = await inviteTestStaff(business, "Cashier"); // limit 5%
    const manager = await inviteTestStaff(business, "Manager");
    const sell = (discountBps: number, approval?: unknown) => callApi(cashier.token, "POST", "/sales", {
      ...as, idempotencyKey: key(),
      body: { shiftId, lines: [piece(products.A, "1", { discount: { type: "percent", bps: discountBps } })], payments: [{ methodId: methods.cash, amountPaisa: 500 }], approval },
    });

    const within = await sell(500);
    expect(within.status, JSON.stringify(within.body)).toBe(201);
    expect(within.body.invoice.totalPaisa).toBe(475);

    const above = await sell(1000);
    expect(above.status).toBe(403);
    expect(above.body.error.code).toBe("DISCOUNT_APPROVAL_REQUIRED");

    const wrongPin = await sell(1000, { managerEmail: manager.email, pin: "9999" });
    expect(wrongPin.status).toBe(401);
    const cashierAsApprover = await sell(1000, { managerEmail: cashier.email, pin: cashier.pin });
    expect(cashierAsApprover.status).toBe(403);

    const approved = await sell(1000, { managerEmail: manager.email, pin: manager.pin });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.invoice.totalPaisa).toBe(450);
    const client = sql();
    const [row] = await client<{ approved_by: string }[]>`SELECT approved_by FROM sales_invoices WHERE id = ${approved.body.invoice.id}`;
    await client.end();
    expect(row.approved_by).toBe(manager.id);
  });
});
