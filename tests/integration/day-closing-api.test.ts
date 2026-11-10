// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
const yesterday = () => new Date(Date.parse(today()) - 86_400_000).toISOString().slice(0, 10);

// v0.7 slice 3 against the real API and database: day-end closing (FR-CSH-07).

/** A day with one shift: float Rs 1,000.00, a cash sale of Rs 10.00, an expense of Rs 3.00 from the bank, and the drawer counted Re 0.50 over. */
async function setup(closeShift = true) {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,100,Piece,1.00" }, idempotencyKey: key() });
  const as = { terminalId: business.terminalId };
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 100_000 }, idempotencyKey: key() });
  expect(shift.status, JSON.stringify(shift.body)).toBe(201);
  const client = sql();
  const [{ id: cash }] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${business.businessId} AND code = 'cash'`;
  await client.end();
  const sale = await callApi(business.ownerToken, "POST", "/sales", {
    ...as, idempotencyKey: key(),
    body: { shiftId: shift.body.id, lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity: "2" }], payments: [{ methodId: cash, amountPaisa: 1_000 }] },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  const bank = (await callApi(business.ownerToken, "POST", "/accounts", { body: { name: "HBL Current", kind: "bank", openingBalancePaisa: 100_000 } })).body;
  const categories = (await callApi(business.ownerToken, "GET", "/expense-categories")).body.data as Array<{ id: string; name: string }>;
  const spend = (date?: string) => callApi(business.ownerToken, "POST", "/expenses", {
    idempotencyKey: key(), body: { categoryId: categories.find((category) => category.name === "Rent")!.id, amountPaisa: 300, paidFrom: "account", accountId: bank.id, ...(date ? { expenseDate: date } : {}) },
  });
  expect((await spend()).status).toBe(201);
  if (closeShift) {
    const closed = await callApi(business.ownerToken, "POST", `/shifts/${shift.body.id}/close`, { ...as, body: { countedPaisa: 101_050 }, idempotencyKey: key() });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  }
  return { business, product, as, shiftId: shift.body.id as string, bank, spend, cash };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const preview = (context: Setup, query = "", token = context.business.ownerToken) => callApi(token, "GET", `/day-closings/preview${query ? `?${query}` : ""}`);
const closeDay = (context: Setup, body: Record<string, unknown> = {}, token = context.business.ownerToken) => callApi(token, "POST", "/day-closings", { body, idempotencyKey: key() });

integration("day-end closing", { timeout: 300_000 }, () => {
  it("is refused while a shift is open, then writes the day down from the shifts and ledgers", async () => {
    const context = await setup(false);
    const early = await preview(context);
    expect(early.status, JSON.stringify(early.body)).toBe(200);
    expect(early.body.openShifts).toBe("Register 1");
    const refused = await closeDay(context);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("SHIFTS_OPEN");
    expect(refused.body.error.message).toMatch(/Register 1/);

    await callApi(context.business.ownerToken, "POST", `/shifts/${context.shiftId}/close`, { ...context.as, body: { countedPaisa: 101_050 }, idempotencyKey: key() });
    const ready = (await preview(context)).body;
    expect(ready).toMatchObject({ date: today(), openShifts: null, closingId: null, branchName: "Main Branch" });
    expect(ready.summary).toMatchObject({
      cashVariancePaisa: 50,
      sales: { bills: 1, totalPaisa: 1_000, creditPaisa: 0, deskBills: 0 },
      returns: { count: 0, totalPaisa: 0 },
      expenses: { count: 1, totalPaisa: 300, byCategory: [{ category: "Rent", expenses: 1, amountPaisa: 300 }] },
      byMethod: [{ method: "Cash", salesPaisa: 1_000, receiptsPaisa: 0, paidOutPaisa: 0, refundsPaisa: 0 }],
    });
    expect(ready.summary.shifts).toHaveLength(1);
    expect(ready.summary.shifts[0]).toMatchObject({ terminal: "Register 1", status: "closed", openingFloatPaisa: 100_000, expectedPaisa: 101_000, countedPaisa: 101_050, variancePaisa: 50 });

    const closed = await closeDay(context, { note: "Quiet day" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    expect(closed.body.number).toMatch(/^CLS-[A-Z0-9]+-\d{6}$/);
    expect(closed.body).toMatchObject({ businessDate: today(), branchName: "Main Branch", note: "Quiet day", reopened: false });
    // What was written is what the preview said, and it agrees with the sales report for the day.
    expect(closed.body.summary).toEqual(ready.summary);
    const report = (await callApi(context.business.ownerToken, "GET", "/report-data/sales-summary")).body;
    expect(closed.body.summary.sales.totalPaisa).toBe(report.rows[0].total);

    // It cannot be closed twice, and it is listed.
    const again = await closeDay(context);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("DAY_CLOSED");
    const list = (await callApi(context.business.ownerToken, "GET", "/day-closings")).body;
    expect(list.total).toBe(1);
    expect(list.data[0]).toMatchObject({ id: closed.body.id, salesPaisa: 1_000, bills: 1, cashVariancePaisa: 50, reopened: false });
    expect((await callApi(context.business.ownerToken, "GET", `/day-closings/${closed.body.id}`)).body.summary.expenses.totalPaisa).toBe(300);
    expect((await preview(context)).body.closingId).toBe(closed.body.id);
  });

  it("a closed day takes no new shift and no expense dated into it, but other days are free", async () => {
    const context = await setup();
    expect((await closeDay(context)).status).toBe(201);
    const open = await callApi(context.business.ownerToken, "POST", "/shifts/open", { ...context.as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
    expect(open.status).toBe(409);
    expect(open.body.error.code).toBe("DAY_CLOSED");
    const spent = await context.spend();
    expect(spent.status).toBe(409);
    expect(spent.body.error.code).toBe("DAY_CLOSED");
    expect((await context.spend(yesterday())).status).toBe(201);
    // The posted sale cannot be touched either.
    const client = sql();
    await expect(client`UPDATE day_closings SET note = 'changed' WHERE business_id = ${context.business.businessId}`).rejects.toThrow(/cannot be changed/);
    await expect(client`DELETE FROM day_closings WHERE business_id = ${context.business.businessId}`).rejects.toThrow(/cannot be deleted/);
    await client.end();
  });

  it("can be reopened with a reason, kept on the record, and closed again as a new record", async () => {
    const context = await setup();
    const first = (await closeDay(context)).body;
    const noReason = await callApi(context.business.ownerToken, "POST", `/day-closings/${first.id}/reopen`, { body: {}, idempotencyKey: key() });
    expect(noReason.status).toBe(400);
    const reopened = await callApi(context.business.ownerToken, "POST", `/day-closings/${first.id}/reopen`, { body: { reason: "Forgot an expense" }, idempotencyKey: key() });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body).toMatchObject({ reopened: true, reopenReason: "Forgot an expense" });
    expect((await callApi(context.business.ownerToken, "POST", `/day-closings/${first.id}/reopen`, { body: { reason: "again" }, idempotencyKey: key() })).status).toBe(404);

    // The day is open again: the forgotten expense goes in, and closing it writes a second record with the new figure.
    expect((await context.spend()).status).toBe(201);
    const second = await closeDay(context);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.number).not.toBe(first.number);
    expect(second.body.summary.expenses.totalPaisa).toBe(600);
    expect(first.summary.expenses.totalPaisa).toBe(300);
    const list = (await callApi(context.business.ownerToken, "GET", "/day-closings")).body;
    expect(list.total).toBe(2);
    expect(list.data.map((row: { reopened: boolean }) => row.reopened).sort()).toEqual([false, true]);
  });

  it("refuses a future day and a stranger's branch, and needs the right permissions", async () => {
    const context = await setup();
    expect((await closeDay(context, { date: "2999-01-01" })).status).toBe(422);
    expect((await preview(context, "date=2999-01-01")).status).toBe(422);
    expect((await closeDay(context, { branchId: crypto.randomUUID() })).status).toBe(422);
    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await callApi(cashier.token, "GET", "/day-closings")).status).toBe(403);
    expect((await closeDay(context, {}, cashier.token)).status).toBe(403);
    const viewer = await inviteStaffWithPermissions(context.business, "Day viewer", ["shifts.view_all"]);
    expect((await callApi(viewer.token, "GET", "/day-closings")).status).toBe(200);
    expect((await preview(context, "", viewer.token)).status).toBe(200);
    expect((await closeDay(context, {}, viewer.token)).status).toBe(403);
    // Another business sees nothing of this one.
    const other = await createTestBusiness();
    expect((await callApi(other.ownerToken, "GET", "/day-closings")).body.total).toBe(0);
    const mine = (await closeDay(context)).body;
    expect((await callApi(other.ownerToken, "GET", `/day-closings/${mine.id}`)).status).toBe(404);
  });

  it("a day with a past open shift cannot be closed until that shift is closed", async () => {
    const context = await setup();
    // A shift left open from yesterday blocks closing today.
    const client = sql();
    await client.begin(async (tx) => {
      await tx`ALTER TABLE shifts DISABLE TRIGGER USER`;
      await tx`INSERT INTO shifts (business_id, branch_id, terminal_id, opened_by, opened_at, opening_float_paisa) SELECT business_id, branch_id, id, ${context.business.ownerId}, now() - interval '1 day', 0 FROM terminals WHERE business_id = ${context.business.businessId} LIMIT 1`;
      await tx`ALTER TABLE shifts ENABLE TRIGGER USER`;
    });
    await client.end();
    const refused = await closeDay(context);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("SHIFTS_OPEN");
  });
});
