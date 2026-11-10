// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

integration("sale list, reprint and daily sales report", { timeout: 180_000 }, () => {
  it("lists a cashier's own sales, logs each reprint as a numbered duplicate, and reports the day", async () => {
    const business = await createTestBusiness();
    const product = await createSimpleProduct(business, "R-1", 200);
    await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nR-1,50,Piece,2.00" }, idempotencyKey: key() });
    const cashier = await inviteTestStaff(business, "Cashier");
    const as = { terminalId: business.terminalId };
    const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
    const client = sql();
    const methods = Object.fromEntries((await client<{ id: string; code: string }[]>`SELECT id, code FROM payment_methods WHERE business_id = ${business.businessId}`).map((row) => [row.code, row.id]));
    await client.end();
    const sell = (token: string, quantity: string, method: string, amount: number) => callApi(token, "POST", "/sales", {
      ...as, idempotencyKey: key(),
      body: { shiftId: shift.body.id, lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity }], payments: [{ methodId: methods[method], amountPaisa: amount }] },
    });

    const ownerSale = await sell(business.ownerToken, "2", "cash", 1000); // 10.00
    const cashierSale = await sell(cashier.token, "4", "jazzcash", 2000); // 20.00
    expect(ownerSale.status, JSON.stringify(ownerSale.body)).toBe(201);
    expect(cashierSale.status, JSON.stringify(cashierSale.body)).toBe(201);

    const mine = await callApi(cashier.token, "GET", "/sales", as);
    expect(mine.body.data.map((row: { number: string }) => row.number)).toEqual(["INV-KHI-000002"]);
    const all = await callApi(business.ownerToken, "GET", "/sales?pageSize=1", as);
    expect(all.body).toMatchObject({ total: 2, pageSize: 1 });
    expect(all.body.data[0].number).toBe("INV-KHI-000002");
    expect((await callApi(business.ownerToken, "GET", "/sales?q=000001", as)).body.total).toBe(1);

    const first = await callApi(business.ownerToken, "POST", `/sales/${ownerSale.body.invoice.id}/reprint`, { ...as, body: { format: "a4" } });
    const second = await callApi(business.ownerToken, "POST", `/sales/${ownerSale.body.invoice.id}/reprint`, { ...as, body: { format: "pos80" } });
    expect(first.body).toMatchObject({ duplicate: true, format: "a4", reprintNumber: 1 });
    expect(first.body.invoice.totalPaisa).toBe(ownerSale.body.invoice.totalPaisa);
    expect(second.body.reprintNumber).toBe(2);
    expect((await callApi(business.ownerToken, "POST", `/sales/${ownerSale.body.invoice.id}/reprint`, { ...as, body: { format: "x" } })).status).toBe(400);
    const audit = await callApi(business.ownerToken, "GET", "/audit-log?pageSize=100");
    expect(audit.body.data.filter((row: { action: string; entityId: string }) => row.action === "reprint" && row.entityId === ownerSale.body.invoice.id)).toHaveLength(2);

    expect((await callApi(cashier.token, "GET", "/reports/daily-sales", as)).status).toBe(403);
    const report = await callApi(business.ownerToken, "GET", "/reports/daily-sales", as);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body).toMatchObject({ invoiceCount: 2, totalPaisa: 3000, grossPaisa: 3000, costPaisa: 1200, profitPaisa: 1800 });
    expect(report.body.byMethod.map((row: { code: string; amountPaisa: number }) => [row.code, row.amountPaisa])).toEqual([["jazzcash", 2000], ["cash", 1000]]);
    expect(report.body.topProducts[0]).toMatchObject({ sku: "R-1", quantityBase: "6", totalPaisa: 3000 });
    expect((await callApi(business.ownerToken, "GET", "/reports/daily-sales?date=2020-01-01", as)).body.invoiceCount).toBe(0);
    expect((await callApi(business.ownerToken, "GET", "/reports/daily-sales?date=nope", as)).status).toBe(400);
  });
});
