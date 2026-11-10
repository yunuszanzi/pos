// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, firstLocationId, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const today = () => new Date().toISOString().slice(0, 10);

// v0.5 slice 3 against the real API and database: supplier bills, landed cost, input tax and the payable.

async function setup() {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  const locationId = await firstLocationId(business);
  const supplier = await callApi(business.ownerToken, "POST", "/suppliers", { body: { name: "Karachi Balloon Mills", termsDays: 30 } });
  expect(supplier.status).toBe(201);
  return { business, product, locationId, supplierId: supplier.body.id as string };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Goods that arrived with no order: `quantity` of a unit at a price. Returns the receipt and its one line. */
async function receiveDirect(context: Setup, quantity: string, unit: "pieceId" | "cartonId" | "packId", costPaisa: number, supplierId = context.supplierId) {
  const posted = await callApi(context.business.ownerToken, "POST", "/goods-receipts", {
    idempotencyKey: key(),
    body: { supplierId, locationId: context.locationId, lines: [{ variantId: context.product.variantId, unitId: context.product[unit], quantity, unitCostPaisa: costPaisa }] },
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(201);
  return { receipt: posted.body.receipt, lineId: posted.body.receipt.lines[0].id as string };
}
const billBody = (context: Setup, lines: Array<{ receiptLineId: string; quantity: string; cost: number; taxRateBps?: number }>, extra: Record<string, unknown> = {}) => ({
  supplierId: context.supplierId, supplierInvoiceNo: `INV-${crypto.randomUUID().slice(0, 6)}`, billDate: today(), note: "", charges: [],
  lines: lines.map((line) => ({ receiptLineId: line.receiptLineId, quantity: line.quantity, unitCostPaisa: line.cost, taxRateBps: line.taxRateBps ?? 0 })), ...extra,
});
const postBill = (context: Setup, body: Record<string, unknown>, token = context.business.ownerToken) => callApi(token, "POST", "/purchase-bills", { idempotencyKey: key(), body });
const stockOf = async (context: Setup) => {
  const client = sql();
  const [row] = await client<{ on_hand: string; avg_cost_paisa: string }[]>`SELECT on_hand::text, avg_cost_paisa::text FROM stock_balances WHERE variant_id = ${context.product.variantId} AND location_id = ${context.locationId}`;
  await client.end();
  return { onHand: row.on_hand, average: Number(row.avg_cost_paisa) };
};
const owedTo = async (context: Setup) => (await callApi(context.business.ownerToken, "GET", `/suppliers/${context.supplierId}`)).body.balancePaisa as number;
const billable = async (context: Setup) => (await callApi(context.business.ownerToken, "GET", `/billable-receipt-lines?supplierId=${context.supplierId}`)).body;

integration("supplier bills", { timeout: 240_000 }, () => {
  it("makes the payable, takes freight into the cost of stock and records input tax", async () => {
    const context = await setup();
    const { receipt, lineId } = await receiveDirect(context, "2", "cartonId", 320_000); // 400 pieces, stock in at Rs 16.00
    expect(await stockOf(context)).toEqual({ onHand: "400.000", average: 1_600 });
    expect((await billable(context)).data).toMatchObject([{ id: lineId, receiptNumber: receipt.number, quantity: "2", unbilledQuantity: "2", unitCostPaisa: 320_000 }]);

    const posted = await postBill(context, billBody(context, [{ receiptLineId: lineId, quantity: "2", cost: 320_000, taxRateBps: 1_800 }], {
      supplierInvoiceNo: "KBM-1001", charges: [{ description: "Freight", amountPaisa: 40_000 }],
    }));
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    // Rs 6,400.00 of goods + Rs 400.00 freight + 18% tax on the goods (Rs 1,152.00) = Rs 7,952.00.
    expect(posted.body).toMatchObject({ supplierInvoiceNo: "KBM-1001", subtotalPaisa: 640_000, chargesPaisa: 40_000, taxPaisa: 115_200, totalPaisa: 795_200 });
    expect(posted.body.number).toMatch(/^BILL-[A-Z0-9]+-\d{6}$/);
    expect(posted.body.lines[0]).toMatchObject({ chargeSharePaisa: 40_000, receiptCostPerBasePaisa: 1_600, absorbedPaisa: 40_000, taxRateBps: 1_800, taxPaisa: 115_200 });
    expect(posted.body.charges).toMatchObject([{ description: "Freight", amountPaisa: 40_000 }]);
    // Due thirty days on, by the supplier's terms.
    const due = new Date(`${today()}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + 30);
    expect(posted.body.dueDate).toBe(due.toISOString().slice(0, 10));

    // The shop owes the supplier the whole bill, tax included; stock now costs Rs 17.00 a piece (the tax is not part of the cost).
    expect(await owedTo(context)).toBe(795_200);
    expect(await stockOf(context)).toEqual({ onHand: "400.000", average: 1_700 });
    const ledger = (await callApi(context.business.ownerToken, "GET", `/suppliers/${context.supplierId}/ledger`)).body;
    expect(ledger.entries).toMatchObject([{ docType: "purchase_bill", memo: "Bill KBM-1001", creditPaisa: 795_200, balanceAfterPaisa: 795_200 }]);
    const movements = (await callApi(context.business.ownerToken, "GET", `/stock/ledger?variantId=${context.product.variantId}`)).body.data;
    expect(movements.map((row: { docType: string; quantity: string }) => [row.docType, row.quantity])).toEqual([["cost_adjustment", "0"], ["goods_receipt", "400"]]);

    // Everything is billed; the payable shows in ageing; the valuation replay agrees with the cached average.
    expect((await billable(context)).data).toEqual([]);
    const ageing = (await callApi(context.business.ownerToken, "GET", "/supplier-ageing")).body;
    expect(ageing.totals).toEqual({ bandsPaisa: [795_200, 0, 0, 0], owedPaisa: 795_200 });
    const valuation = (await callApi(context.business.ownerToken, "GET", "/stock/valuation")).body;
    expect(valuation.rows[0]).toMatchObject({ onHand: "400", costValuePaisa: 680_000 }); // 400 x Rs 17.00
  });

  it("corrects the cost of stock when the supplier charged a different price, but only for what is still held", async () => {
    const context = await setup();
    const { lineId } = await receiveDirect(context, "100", "pieceId", 1_000); // 100 pieces in at Rs 10.00

    // 60 are sold at the Rs 10.00 they came in at.
    const client = sql();
    const [cash] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${context.business.businessId} AND code = 'cash'`;
    await client.end();
    const shift = await callApi(context.business.ownerToken, "POST", "/shifts/open", { terminalId: context.business.terminalId, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
    const sale = await callApi(context.business.ownerToken, "POST", "/sales", {
      terminalId: context.business.terminalId, idempotencyKey: key(),
      body: { shiftId: shift.body.id, customerId: null, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "60" }], payments: [{ methodId: cash.id, amountPaisa: 30_000 }] },
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(await stockOf(context)).toEqual({ onHand: "40.000", average: 1_000 });

    // The supplier's invoice says Rs 12.00: Rs 200.00 more for the 100. Only the 40 still held can carry it: Rs 80.00, so +Rs 2.00 each.
    const posted = await postBill(context, billBody(context, [{ receiptLineId: lineId, quantity: "100", cost: 1_200 }]));
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    expect(posted.body.lines[0]).toMatchObject({ unitCostPaisa: 1_200, lineValuePaisa: 120_000, receiptCostPerBasePaisa: 1_000, absorbedPaisa: 8_000 });
    expect(await stockOf(context)).toEqual({ onHand: "40.000", average: 1_200 });
    expect(await owedTo(context)).toBe(120_000); // the payable is what the supplier billed

    // A bill that is cheaper takes cost off the stock still held.
    const second = await receiveDirect(context, "40", "pieceId", 1_500);
    const cheaper = await postBill(context, billBody(context, [{ receiptLineId: second.lineId, quantity: "40", cost: 1_400 }]));
    expect(cheaper.body.lines[0].absorbedPaisa).toBe(-4_000);
    // 80 held now: 40 at Rs 12.00 plus 40 received at Rs 15.00 = Rs 13.50, then -Rs 40.00 over 80 = -50c: Rs 13.00.
    expect((await stockOf(context)).average).toBe(1_300);
  });

  it("bills a receipt in parts, never more than was received, and shares freight by value", async () => {
    const context = await setup();
    const first = await receiveDirect(context, "100", "pieceId", 1_000);
    const second = await receiveDirect(context, "50", "pieceId", 3_000);

    const part = await postBill(context, billBody(context, [{ receiptLineId: first.lineId, quantity: "60", cost: 1_000 }]));
    expect(part.status, JSON.stringify(part.body)).toBe(201);
    expect((await billable(context)).data.map((row: { id: string; unbilledQuantity: string }) => [row.id, row.unbilledQuantity])).toEqual([[first.lineId, "40"], [second.lineId, "50"]]);

    const tooMuch = await postBill(context, billBody(context, [{ receiptLineId: first.lineId, quantity: "41", cost: 1_000 }]));
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe("BILL_EXCEEDS_RECEIPT");

    // Freight of Rs 10.00 on the rest, shared by value: goods worth Rs 400.00 and Rs 1,500.00.
    const rest = await postBill(context, billBody(context, [{ receiptLineId: first.lineId, quantity: "40", cost: 1_000 }, { receiptLineId: second.lineId, quantity: "50", cost: 3_000 }], {
      charges: [{ description: "Freight", amountPaisa: 1_000 }],
    }));
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    const shares = rest.body.lines.map((line: { chargeSharePaisa: number }) => line.chargeSharePaisa);
    expect(shares).toEqual([211, 789]); // 1000 x 40,000 / 190,000 = 210.53 and 789.47: the larger fraction takes the spare paisa
    expect(shares[0] + shares[1]).toBe(1_000);
    expect(rest.body.totalPaisa).toBe(40_000 + 150_000 + 1_000);
    expect((await billable(context)).data).toEqual([]);
    expect(await owedTo(context)).toBe(60_000 + 191_000);
  });

  it("refuses a repeated supplier invoice number, other suppliers' goods and bad input", async () => {
    const context = await setup();
    const { lineId } = await receiveDirect(context, "10", "pieceId", 1_000);
    const first = await postBill(context, billBody(context, [{ receiptLineId: lineId, quantity: "4", cost: 1_000 }], { supplierInvoiceNo: "SAME-1" }));
    expect(first.status).toBe(201);
    const again = await postBill(context, billBody(context, [{ receiptLineId: lineId, quantity: "2", cost: 1_000 }], { supplierInvoiceNo: " same-1 " }));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("BILL_EXISTS");

    // Goods another supplier delivered cannot go on this supplier's bill.
    const other = await callApi(context.business.ownerToken, "POST", "/suppliers", { body: { name: "Someone Else" } });
    const theirs = await receiveDirect(context, "5", "pieceId", 1_000, other.body.id);
    const wrong = await postBill(context, billBody(context, [{ receiptLineId: theirs.lineId, quantity: "5", cost: 1_000 }]));
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe("INVALID_LINE");
    // ...but that supplier may use the same invoice number.
    expect((await postBill(context, billBody(context, [{ receiptLineId: theirs.lineId, quantity: "5", cost: 1_000 }], { supplierId: other.body.id, supplierInvoiceNo: "SAME-1" }))).status).toBe(201);

    expect((await postBill(context, billBody(context, [{ receiptLineId: crypto.randomUUID(), quantity: "1", cost: 100 }]))).status).toBe(422);
    expect((await postBill(context, billBody(context, []))).status).toBe(400);
    expect((await postBill(context, billBody(context, [{ receiptLineId: lineId, quantity: "1", cost: 100 }], { billDate: "2026-02-30" }))).status).toBe(400);
    expect((await postBill(context, billBody(context, [{ receiptLineId: lineId, quantity: "1", cost: 100 }], { supplierInvoiceNo: " " }))).status).toBe(400);
    expect((await postBill(context, billBody(context, [{ receiptLineId: lineId, quantity: "abc", cost: 100 }]))).status).toBe(400);
    expect((await postBill(context, billBody(context, [{ receiptLineId: lineId, quantity: "1", cost: 100 }], { supplierId: crypto.randomUUID() }))).status).toBe(422);
    expect((await postBill(context, billBody(context, [{ receiptLineId: lineId, quantity: "1", cost: 100 }, { receiptLineId: lineId, quantity: "1", cost: 100 }]))).status).toBe(422);
  });

  it("lists bills, replays a retried bill, and keeps a posted bill immutable", async () => {
    const context = await setup();
    const { lineId } = await receiveDirect(context, "10", "pieceId", 1_000);
    const body = billBody(context, [{ receiptLineId: lineId, quantity: "10", cost: 1_000 }], { supplierInvoiceNo: "LIST-1" });
    const requestKey = key();
    const first = await callApi(context.business.ownerToken, "POST", "/purchase-bills", { idempotencyKey: requestKey, body });
    const replay = await callApi(context.business.ownerToken, "POST", "/purchase-bills", { idempotencyKey: requestKey, body });
    expect(first.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replay")).toBe("true");
    expect(replay.body.id).toBe(first.body.id);
    expect(await owedTo(context)).toBe(10_000);

    const list = await callApi(context.business.ownerToken, "GET", "/purchase-bills?q=LIST");
    expect(list.body).toMatchObject({ total: 1, data: [{ number: first.body.number, supplierInvoiceNo: "LIST-1", totalPaisa: 10_000 }] });
    expect((await callApi(context.business.ownerToken, "GET", `/purchase-bills?supplierId=${context.supplierId}&pageSize=1`)).body.data).toHaveLength(1);
    expect((await callApi(context.business.ownerToken, "GET", `/purchase-bills/${first.body.id}`)).body.lines).toHaveLength(1);
    expect((await callApi(context.business.ownerToken, "GET", "/purchase-bills/not-an-id")).status).toBe(404);
    expect((await callApi(context.business.ownerToken, "GET", "/billable-receipt-lines")).status).toBe(400);

    const client = sql();
    await expect(client`UPDATE purchase_bills SET note = 'x' WHERE id = ${first.body.id}`).rejects.toThrow(/cannot be changed/);
    await expect(client`DELETE FROM purchase_bill_lines WHERE bill_id = ${first.body.id}`).rejects.toThrow(/cannot be changed/);
    await expect(client`UPDATE party_ledger SET credit_paisa = 1 WHERE doc_id = ${first.body.id}`).rejects.toThrow();
    await client.end();
  });

  it("needs both the permission to bill and the permission to see costs", async () => {
    const context = await setup();
    const { lineId } = await receiveDirect(context, "10", "pieceId", 1_000);
    const body = billBody(context, [{ receiptLineId: lineId, quantity: "1", cost: 1_000 }]);
    const withoutCost = await inviteStaffWithPermissions(context.business, "Biller without costs", ["purchasing.bill", "purchasing.view"]);
    expect((await postBill(context, body, withoutCost.token)).status).toBe(403);
    expect((await callApi(withoutCost.token, "GET", "/purchase-bills")).status).toBe(403);
    expect((await callApi(withoutCost.token, "GET", `/billable-receipt-lines?supplierId=${context.supplierId}`)).status).toBe(403);
    const withoutBill = await inviteStaffWithPermissions(context.business, "Cost viewer", ["products.cost.view", "purchasing.view"]);
    expect((await postBill(context, body, withoutBill.token)).status).toBe(403);
    const both = await inviteStaffWithPermissions(context.business, "Accounts clerk", ["purchasing.bill", "products.cost.view", "suppliers.view"]);
    expect((await postBill(context, body, both.token)).status).toBe(201);
    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await postBill(context, body, cashier.token)).status).toBe(403);
    expect((await callApi("", "GET", "/purchase-bills")).status).toBe(401);
  });
});
