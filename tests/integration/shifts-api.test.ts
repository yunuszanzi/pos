// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createTestBusiness, hasLocalStack, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

integration("shifts API", { timeout: 120_000 }, () => {
  it("opens one shift per terminal, takes cash movements, and closes with a blind count and variance", async () => {
    const business = await createTestBusiness();
    const as = { terminalId: business.terminalId };

    expect((await callApi(business.ownerToken, "GET", "/shifts/current", as)).body).toBeNull();

    const opened = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 500_000 }, idempotencyKey: key() });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const shiftId = opened.body.id as string;

    const again = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("SHIFT_ALREADY_OPEN");

    const current = await callApi(business.ownerToken, "GET", "/shifts/current", as);
    expect(current.body.id).toBe(shiftId);
    expect(current.body).not.toHaveProperty("expectedPaisa");

    const cashOut = await callApi(business.ownerToken, "POST", `/shifts/${shiftId}/cash-movements`, {
      ...as, body: { kind: "cash_out", amountPaisa: 20_000, reason: "Tea" }, idempotencyKey: key(),
    });
    expect(cashOut.status).toBe(201);
    const noReason = await callApi(business.ownerToken, "POST", `/shifts/${shiftId}/cash-movements`, {
      ...as, body: { kind: "cash_in", amountPaisa: 100, reason: " " }, idempotencyKey: key(),
    });
    expect(noReason.status).toBe(400);

    const x = await callApi(business.ownerToken, "GET", `/shifts/${shiftId}/report`, as);
    expect(x.body.kind).toBe("X");
    expect(x.body.report.expectedCashPaisa).toBe(480_000);

    const closed = await callApi(business.ownerToken, "POST", `/shifts/${shiftId}/close`, {
      ...as, body: { countedPaisa: 479_000, countedBreakdown: { "5000": 95, "1000": 4 }, note: "short by 10" }, idempotencyKey: key(),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.shift).toMatchObject({ status: "closed", expectedPaisa: 480_000, countedPaisa: 479_000, variancePaisa: -1_000 });

    const late = await callApi(business.ownerToken, "POST", `/shifts/${shiftId}/cash-movements`, {
      ...as, body: { kind: "cash_in", amountPaisa: 100, reason: "late" }, idempotencyKey: key(),
    });
    expect(late.status).toBe(409);
    const closeTwice = await callApi(business.ownerToken, "POST", `/shifts/${shiftId}/close`, { ...as, body: { countedPaisa: 0 }, idempotencyKey: key() });
    expect(closeTwice.status).toBe(409);

    const z = await callApi(business.ownerToken, "GET", `/shifts/${shiftId}/report`, as);
    expect(z.body.kind).toBe("Z");
    expect(z.body.shift.variancePaisa).toBe(-1_000);

    // A closed shift frees the terminal for the next one.
    const next = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
    expect(next.status).toBe(201);
  });

  it("counts cash sales (not change, not wallet) into the expected cash", async () => {
    const business = await createTestBusiness();
    const as = { terminalId: business.terminalId };
    const opened = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 1_000 }, idempotencyKey: key() });
    const shiftId = opened.body.id as string;
    const client = sql();
    try {
      // A 500 sale paid 300 cash + 200 wallet, with 0 change; the shift should expect 1,000 + 300.
      const [location] = await client<{ id: string }[]>`SELECT id FROM locations WHERE business_id = ${business.businessId} LIMIT 1`;
      const [cash] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${business.businessId} AND code = 'cash'`;
      const [wallet] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${business.businessId} AND code = 'jazzcash'`;
      const [invoice] = await client<{ id: string }[]>`
        INSERT INTO sales_invoices (business_id, branch_id, terminal_id, shift_id, location_id, number, sequence_no, cashier_id, tax_mode,
          gross_paisa, line_discount_paisa, invoice_discount_paisa, taxable_paisa, tax_paisa, rounding_paisa, total_paisa, paid_paisa, change_paisa, balance_paisa)
        VALUES (${business.businessId}, ${business.branchId}, ${business.terminalId}, ${shiftId}, ${location.id}, 'T-1', 1, ${business.ownerId}, 'inclusive',
          500, 0, 0, 500, 0, 0, 500, 500, 0, 0) RETURNING id`;
      await client`
        INSERT INTO payments (business_id, invoice_id, method_id, method_code, method_name, tender_kind, amount_paisa, tendered_paisa, change_paisa)
        VALUES (${business.businessId}, ${invoice.id}, ${cash.id}, 'cash', 'Cash', 'cash', 300, 400, 100),
               (${business.businessId}, ${invoice.id}, ${wallet.id}, 'jazzcash', 'JazzCash', 'other', 200, 200, 0)`;
    } finally {
      await client.end();
    }
    const report = await callApi(business.ownerToken, "GET", `/shifts/${shiftId}/report`, as);
    expect(report.body.report).toMatchObject({ invoiceCount: 1, totalPaisa: 500, cashSalesPaisa: 300, expectedCashPaisa: 1_300 });
    expect(report.body.report.byMethod.map((row: { code: string }) => row.code)).toEqual(["cash", "jazzcash"]);
  });
});
