// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mockCalls } from "../../server/fbr/adapters/mock";
import { attemptSubmission } from "../../server/fbr/service";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql, type TestBusiness } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

// v0.8 slice 2 against the real API and database, with the built-in mock standing in for FBR (the token chooses how it behaves):
// reporting sales and returns, FBR being down, FBR refusing, the retry queue, and never reporting a document twice.

const OK = "mock-ok-token";

async function setup(options: { fbr?: boolean; token?: string; hsCode?: string } = {}) {
  const business = await createTestBusiness();
  const tax = await callApi(business.ownerToken, "POST", "/tax-categories", { body: { name: "GST 18%", kind: "standard", rateBps: 1800 } });
  const product = await createSimpleProduct(business, "A", 100, { taxCategoryId: tax.body.id, ...(options.hsCode === "" ? {} : { hsCode: options.hsCode ?? "9503.0090" }) });
  await callApi(business.ownerToken, "PUT", `/fbr/tax-categories/${tax.body.id}`, { body: { fbrSaleType: "Goods at standard rate (default)" } });
  const client = sql();
  await client`UPDATE product_units SET fbr_uom = 'Numbers, pieces, units' WHERE business_id = ${business.businessId}`;
  const methods = Object.fromEntries((await client<{ id: string; code: string }[]>`SELECT id, code FROM payment_methods WHERE business_id = ${business.businessId}`).map((row) => [row.code, row.id]));
  await client.end();
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,1000,Piece,1.00" }, idempotencyKey: key() });
  const as = { terminalId: business.terminalId };
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
  expect(shift.status, JSON.stringify(shift.body)).toBe(201);
  if (options.fbr !== false) {
    expect((await callApi(business.ownerToken, "PUT", "/fbr/token", { body: { token: options.token ?? OK } })).status).toBe(200);
    const on = await callApi(business.ownerToken, "PUT", "/fbr/config", {
      body: { enabled: true, mode: "di", environment: "sandbox", sellerName: "Example Traders (Pvt) Ltd", sellerNtn: "1234567-8", sellerStrn: "17-00-1234-567-89", sellerProvince: "SINDH", sellerAddress: "Shop 4, Saddar, Karachi", cancelWindowHours: 72, buyerIdThresholdPaisa: 5_000_000, confirmUntested: false },
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  }
  return { business, product, as, shiftId: shift.body.id as string, methods, taxId: tax.body.id as string };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const sell = (context: Setup, quantity = "10", extra: Record<string, unknown> = {}, paid = true) => callApi(context.business.ownerToken, "POST", "/sales", {
  ...context.as, idempotencyKey: key(),
  body: {
    shiftId: context.shiftId, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity }],
    payments: paid ? [{ methodId: context.methods.cash, amountPaisa: Number(quantity) * 500 }] : [], ...extra,
  },
});
const setToken = (context: Setup, token: string) => callApi(context.business.ownerToken, "PUT", "/fbr/token", { body: { token } });
const submissionOf = async (invoiceId: string) => {
  const client = sql();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [row] = await client<Array<{ id: string; status: string; attempts: number; irn: string | null; error_code: string | null; error_message: string | null; next_retry_at: Date | null; payload: any }>>`
    SELECT id, status, attempts, irn, error_code, error_message, next_retry_at, payload FROM fbr_submissions WHERE doc_id = ${invoiceId}`;
  await client.end();
  return row;
};
const sqlRun = async <T>(work: (client: ReturnType<typeof sql>) => Promise<T>) => { const client = sql(); try { return await work(client); } finally { await client.end(); } };
const postsWith = (token: string) => mockCalls.filter((call) => call.kind === "post" && call.token === token);
/** The retry job, scoped to one business so that other test files running at the same time cannot be picked up by it. */
const job = async (scope: { business: TestBusiness } | null, secret: string | null = process.env.CRON_SECRET!, method = "POST") => {
  const { app } = await import("../../server/app");
  const response = await app.fetch(new Request(`http://localhost/api/jobs/fbr-retry${scope ? `?businessId=${scope.business.businessId}` : ""}`, { method, headers: secret ? { Authorization: `Bearer ${secret}` } : {} }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: await response.json() as Record<string, any> };
};
/** Make everything pending due now, as if the wait had passed. */
const makeDue = (business: TestBusiness) => sqlRun((client) => client`UPDATE fbr_submissions SET next_retry_at = now() - interval '1 second', claimed_until = NULL WHERE business_id = ${business.businessId} AND status = 'pending'`);

integration("reporting to FBR", { timeout: 600_000 }, () => {
  it("acceptance 1: a sale is accepted by FBR at once, and the invoice carries FBR's number and the QR data", async () => {
    const context = await setup();
    const sale = await sell(context);
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const invoice = sale.body.invoice;
    expect(invoice.fbrStatus).toBe("accepted");
    expect(invoice.fbrIrn).toMatch(/^12345678DI[0-9A-F]{12}$/);
    expect(invoice.fbrQr).toBe(invoice.fbrIrn);

    const submission = await submissionOf(invoice.id);
    expect(submission).toMatchObject({ status: "accepted", attempts: 1, irn: invoice.fbrIrn });
    // What was sent: a sale to an unregistered counter buyer, tax-inclusive Rs 50.00 of which Rs 7.63 is tax, in the sandbox as scenario SN026.
    expect(submission.payload).toMatchObject({
      invoiceType: "Sale Invoice", sellerNTNCNIC: "12345678", sellerBusinessName: "Example Traders (Pvt) Ltd", sellerProvince: "SINDH", buyerRegistrationType: "Unregistered", scenarioId: "SN026", invoiceRefNo: "",
    });
    expect(submission.payload.items).toEqual([expect.objectContaining({
      hsCode: "9503.0090", rate: "18%", uoM: "Numbers, pieces, units", quantity: 10, totalValues: 50, valueSalesExcludingST: 42.37, salesTaxApplicable: 7.63, saleType: "Goods at standard rate (default)",
    })]);
    // The log holds the validate step and the post step with the request and FBR's answer.
    const detail = (await callApi(context.business.ownerToken, "GET", `/fbr/submissions/${submission.id}`)).body;
    expect(detail.attempts.map((attempt: { step: string; outcome: string }) => [attempt.step, attempt.outcome])).toEqual([["validate", "valid"], ["post", "accepted"]]);
    expect(detail.attempts[1].request.items).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toContain(OK);
    // The same number is on the stored invoice, so a reprint needs no FBR.
    const stored = (await callApi(context.business.ownerToken, "GET", `/sales/${invoice.id}`)).body;
    expect(stored).toMatchObject({ fbrStatus: "accepted", fbrIrn: invoice.fbrIrn });
  });

  it("sends a registered buyer's details, and a desk invoice goes the same way", async () => {
    const context = await setup();
    const customer = (await callApi(context.business.ownerToken, "POST", "/customers", {
      body: { name: "Bilal Wholesale", businessName: "Bilal Traders", phone: "0301-1111111", ntn: "7654321-1", registered: true, address: "Shop 9, Jodia Bazaar", creditLimitPaisa: 10_000_000, termsDays: 15 },
    })).body;
    const sale = await sell(context, "4", { customerId: customer.id });
    expect(sale.body.invoice.fbrStatus).toBe("accepted");
    expect((await submissionOf(sale.body.invoice.id)).payload).toMatchObject({ buyerNTNCNIC: "76543211", buyerBusinessName: "Bilal Traders", buyerRegistrationType: "Registered", buyerAddress: "Shop 9, Jodia Bazaar", scenarioId: "SN001" });

    const desk = await callApi(context.business.ownerToken, "POST", "/sales-invoices", {
      idempotencyKey: key(), body: { customerId: customer.id, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "6" }] },
    });
    expect(desk.status, JSON.stringify(desk.body)).toBe(201);
    expect(desk.body.invoice).toMatchObject({ channel: "back_office", fbrStatus: "accepted" });
    expect((await submissionOf(desk.body.invoice.id)).payload).toMatchObject({ buyerRegistrationType: "Registered", scenarioId: "SN001" });
  });

  it("does nothing when FBR is off, or the terminal has opted out", async () => {
    const off = await setup({ fbr: false });
    const plain = await sell(off);
    expect(plain.status).toBe(201);
    expect(plain.body.invoice.fbrStatus).toBeNull();
    expect(await sqlRun((client) => client`SELECT count(*)::int AS n FROM fbr_submissions WHERE business_id = ${off.business.businessId}`)).toEqual([{ n: 0 }]);

    const on = await setup();
    const terminals = (await callApi(on.business.ownerToken, "GET", "/fbr/terminals")).body.data;
    await callApi(on.business.ownerToken, "PUT", `/fbr/terminals/${terminals[0].id}`, { body: { fbrPosId: "", fbrEnabled: false } });
    const optedOut = await sell(on);
    expect(optedOut.body.invoice.fbrStatus).toBeNull();
    // Missing HS codes do not stop a sale that FBR does not need.
    await sqlRun((client) => client`UPDATE products SET hs_code = NULL WHERE business_id = ${on.business.businessId}`);
    expect((await sell(on)).status).toBe(201);
  });

  it("blocks a sale that lacks what FBR needs, says what to fix, and posts nothing; fixing it lets the sale through", async () => {
    const context = await setup({ hsCode: "" });
    const blocked = await sell(context);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe("FBR_INCOMPLETE");
    expect(blocked.body.error.message).toContain("Product A: add its HS code (on the product)");
    expect(await sqlRun((client) => client`SELECT (SELECT count(*) FROM sales_invoices WHERE business_id = ${context.business.businessId})::int AS invoices, (SELECT on_hand FROM stock_balances WHERE business_id = ${context.business.businessId} LIMIT 1)::text AS on_hand`)).toEqual([{ invoices: 0, on_hand: "1000.000" }]);

    await sqlRun((client) => client`UPDATE products SET hs_code = '9503.0090' WHERE business_id = ${context.business.businessId}`);
    await sqlRun((client) => client`UPDATE product_units SET fbr_uom = NULL WHERE business_id = ${context.business.businessId}`);
    expect((await sell(context)).body.error.message).toContain("add its FBR unit of measure");
    await sqlRun((client) => client`UPDATE product_units SET fbr_uom = 'Numbers, pieces, units' WHERE business_id = ${context.business.businessId}`);

    // A registered customer needs an NTN; a big unregistered sale needs the buyer identified.
    const noNtn = (await callApi(context.business.ownerToken, "POST", "/customers", { body: { name: "No NTN Traders", phone: "0302-2222222", registered: true, creditLimitPaisa: 10_000_000 } })).body;
    const needsNtn = await sell(context, "2", { customerId: noNtn.id });
    expect(needsNtn.status).toBe(422);
    expect(needsNtn.body.error.message).toContain("No NTN Traders is registered for sales tax: add their NTN to the customer");
    await callApi(context.business.ownerToken, "PUT", "/fbr/config", { body: { enabled: true, mode: "di", environment: "sandbox", sellerName: "Example Traders (Pvt) Ltd", sellerNtn: "1234567-8", sellerProvince: "SINDH", sellerAddress: "Karachi", cancelWindowHours: 72, buyerIdThresholdPaisa: 1_000, confirmUntested: false } });
    const large = await sell(context, "10");
    expect(large.status).toBe(422);
    expect(large.body.error.message).toContain("FBR needs the buyer's CNIC or NTN");
    // A small sale under the threshold needs no identity.
    expect((await sell(context, "1")).status).toBe(201);
  }, 120_000);

  it("acceptance 2: with FBR down the sale completes as pending, and is accepted by the retry job once FBR is back, exactly once", async () => {
    const context = await setup({ token: "mock-down" });
    const sale = await sell(context);
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.invoice).toMatchObject({ fbrStatus: "pending", fbrIrn: null });
    const waiting = await submissionOf(sale.body.invoice.id);
    expect(waiting).toMatchObject({ status: "pending", attempts: 1 });
    expect(waiting.error_message).toContain("could not be reached");
    expect(Date.parse(String(waiting.next_retry_at)) - Date.now()).toBeGreaterThan(30_000); // one minute on
    expect(Date.parse(String(waiting.next_retry_at)) - Date.now()).toBeLessThanOrEqual(61_000);
    // FBR never saw it.
    expect(postsWith("mock-down")).toHaveLength(0);

    // Not due yet: the job leaves it. FBR comes back; the job, when it is due, reports it.
    expect((await job(context)).body.tried).toBe(0);
    await setToken(context, OK);
    await makeDue(context.business);
    const before = postsWith(OK).length;
    const ran = await job(context);
    expect(ran.status).toBe(200);
    expect(ran.body).toMatchObject({ tried: 1, accepted: 1 });
    const done = await submissionOf(sale.body.invoice.id);
    expect(done).toMatchObject({ status: "accepted", attempts: 2 });
    expect(done.irn).toMatch(/^12345678DI/);
    expect(postsWith(OK).length - before).toBe(1);
    expect((await callApi(context.business.ownerToken, "GET", `/sales/${sale.body.invoice.id}`)).body).toMatchObject({ fbrStatus: "accepted", fbrIrn: done.irn });
    // Running the job again, or trying to send it again, does not report it a second time.
    expect((await job(context)).body.tried).toBe(0);
    const again = await attemptSubmission(done.id);
    expect(again.status).toBe("accepted");
    expect(postsWith(OK).length - before).toBe(1);
    const retry = await callApi(context.business.ownerToken, "POST", `/fbr/submissions/${done.id}/retry`, { idempotencyKey: key() });
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe("ALREADY_ACCEPTED");
  });

  it("backs off 1, 5 and 15 minutes, and gives up after the window, raising it as failed", async () => {
    const context = await setup({ token: "mock-down" });
    const sale = await sell(context);
    const id = (await submissionOf(sale.body.invoice.id)).id;
    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await makeDue(context.business);
      await attemptSubmission(id);
      const row = await submissionOf(sale.body.invoice.id);
      delays.push(Math.round((Date.parse(String(row.next_retry_at)) - Date.now()) / 60_000));
    }
    expect(delays).toEqual([5, 15, 60]); // after attempts 2, 3 and 4 (attempt 1 waited one minute)
    await sqlRun((client) => client`UPDATE fbr_submissions SET created_at = now() - interval '80 hours', next_retry_at = now() - interval '1 second', claimed_until = NULL WHERE doc_id = ${sale.body.invoice.id}`);
    await attemptSubmission(id);
    const failed = await submissionOf(sale.body.invoice.id);
    expect(failed).toMatchObject({ status: "failed", error_code: "GAVE_UP" });
    expect((await callApi(context.business.ownerToken, "GET", `/sales/${sale.body.invoice.id}`)).body.fbrStatus).toBe("failed");
    // A failed one is not picked up by the job again; it is resubmitted by hand when FBR is back.
    await setToken(context, OK);
    expect((await job(context)).body.tried).toBe(0);
    const resent = await callApi(context.business.ownerToken, "POST", `/fbr/submissions/${id}/retry`, { idempotencyKey: key() });
    expect(resent.body.status).toBe("accepted");
  });

  it("never sends the same document twice at the same moment", async () => {
    const context = await setup({ token: "mock-down" });
    const sale = await sell(context);
    const id = (await submissionOf(sale.body.invoice.id)).id;
    await setToken(context, OK);
    await makeDue(context.business);
    const before = postsWith(OK).length;
    const results = await Promise.all([attemptSubmission(id), attemptSubmission(id), attemptSubmission(id), attemptSubmission(id)]);
    expect(postsWith(OK).length - before).toBe(1);
    expect(results.filter((result) => !result.busy && result.status === "accepted").length).toBeGreaterThanOrEqual(1);
    expect((await submissionOf(sale.body.invoice.id)).status).toBe("accepted");
  });

  it("when FBR refuses the data it is flagged, not retried; fixing it and resubmitting is accepted", async () => {
    const context = await setup({ hsCode: "0000.0000" });
    const postsBefore = postsWith(OK).length;
    const sale = await sell(context);
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.invoice.fbrStatus).toBe("rejected");
    const refused = await submissionOf(sale.body.invoice.id);
    expect(refused).toMatchObject({ status: "rejected", error_code: "0044" });
    expect(refused.error_message).toContain("HS Code");
    expect((await job(context)).body.tried).toBe(0);
    expect(postsWith(OK).length - postsBefore).toBe(0); // refused at the validate step, so nothing was posted

    await sqlRun((client) => client`UPDATE products SET hs_code = '9503.0090' WHERE business_id = ${context.business.businessId}`);
    const manager = await inviteTestStaff(context.business, "Manager");
    const fixed = await callApi(manager.token, "POST", `/fbr/submissions/${refused.id}/retry`, { idempotencyKey: key() });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body).toMatchObject({ status: "accepted" });
    expect((await callApi(context.business.ownerToken, "GET", `/sales/${sale.body.invoice.id}`)).body).toMatchObject({ fbrStatus: "accepted" });

    // A refusal older than FBR's correction window cannot be sent again.
    const old = await sell(context);
    await sqlRun((client) => client`UPDATE products SET hs_code = '0000.0000' WHERE business_id = ${context.business.businessId}`);
    const second = await sell(context);
    expect(second.body.invoice.fbrStatus).toBe("rejected");
    await sqlRun((client) => client`ALTER TABLE sales_invoices DISABLE TRIGGER sales_invoices_protect`);
    await sqlRun((client) => client`UPDATE sales_invoices SET posted_at = now() - interval '100 hours' WHERE id = ${second.body.invoice.id}`);
    await sqlRun((client) => client`ALTER TABLE sales_invoices ENABLE TRIGGER sales_invoices_protect`);
    const tooLate = await callApi(context.business.ownerToken, "POST", `/fbr/submissions/${(await submissionOf(second.body.invoice.id)).id}/retry`, { idempotencyKey: key() });
    expect(tooLate.status).toBe(409);
    expect(tooLate.body.error.code).toBe("WINDOW_PASSED");
    expect(old.status).toBe(201);
  }, 120_000);

  it("a refused token is a failure to fix, not a loop: the sale stands, the job leaves it, and resubmitting after a new token works", async () => {
    const context = await setup({ token: "mock-auth" });
    const sale = await sell(context);
    expect(sale.status).toBe(201);
    expect(sale.body.invoice.fbrStatus).toBe("failed");
    const row = await submissionOf(sale.body.invoice.id);
    expect(row).toMatchObject({ status: "failed", error_code: "UNAUTHORISED" });
    expect((await job(context)).body.tried).toBe(0);
    await setToken(context, OK);
    expect((await callApi(context.business.ownerToken, "POST", `/fbr/submissions/${row.id}/retry`, { idempotencyKey: key() })).body.status).toBe("accepted");
  });

  it("acceptance 3: a partial return is reported as a debit note against the original FBR number", async () => {
    const context = await setup();
    const sale = await sell(context);
    const original = sale.body.invoice;
    const lineId = (await sqlRun((client) => client<{ id: string }[]>`SELECT id FROM sales_invoice_lines WHERE invoice_id = ${original.id}`))[0].id;
    const shiftReturn = (quantity: string) => callApi(context.business.ownerToken, "POST", "/returns", {
      ...context.as, idempotencyKey: key(),
      body: { shiftId: context.shiftId, invoiceId: original.id, lines: [{ originalLineId: lineId, quantity, restockTo: "sellable" }], refund: { methodId: context.methods.cash } },
    });
    const back = await shiftReturn("4");
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    const note = back.body.creditNote;
    expect(note).toMatchObject({ fbrStatus: "accepted" });
    expect(note.fbrIrn).toMatch(/^12345678DN/);
    expect(note.fbrIrn).not.toBe(original.fbrIrn);
    const sent = (await submissionOf(note.id)).payload;
    expect(sent).toMatchObject({ invoiceType: "Debit Note", invoiceRefNo: original.fbrIrn, buyerRegistrationType: "Unregistered" });
    expect(sent.items[0]).toMatchObject({ quantity: 4, totalValues: 20, valueSalesExcludingST: 16.95, salesTaxApplicable: 3.05, hsCode: "9503.0090" });
    // A second partial return is its own debit note against the same invoice.
    const second = await shiftReturn("2");
    expect(second.body.creditNote.fbrIrn).not.toBe(note.fbrIrn);
    expect((await submissionOf(second.body.creditNote.id)).payload.invoiceRefNo).toBe(original.fbrIrn);
  });

  it("a return waits for its invoice to be accepted, and is then accepted after it; one for a sale FBR never saw is not reported", async () => {
    const context = await setup({ token: "mock-down" });
    const sale = await sell(context);
    const lineId = (await sqlRun((client) => client<{ id: string }[]>`SELECT id FROM sales_invoice_lines WHERE invoice_id = ${sale.body.invoice.id}`))[0].id;
    const back = await callApi(context.business.ownerToken, "POST", "/returns", {
      ...context.as, idempotencyKey: key(),
      body: { shiftId: context.shiftId, invoiceId: sale.body.invoice.id, lines: [{ originalLineId: lineId, quantity: "3", restockTo: "sellable" }], refund: { methodId: context.methods.cash } },
    });
    expect(back.body.creditNote.fbrStatus).toBe("pending");
    const waiting = await submissionOf(back.body.creditNote.id);
    expect(waiting.error_message).toContain("Waiting for FBR to accept the invoice");
    expect(waiting.attempts).toBe(0); // waiting is not a try

    await setToken(context, OK);
    await makeDue(context.business);
    const ran = await job(context);
    expect(ran.body).toMatchObject({ tried: 2, accepted: 2 });
    expect((await submissionOf(sale.body.invoice.id)).status).toBe("accepted");
    expect((await submissionOf(back.body.creditNote.id)).status).toBe("accepted");
    const debit = postsWith(OK).filter((call) => call.payload.invoiceType === "Debit Note").at(-1)!;
    expect(debit.payload.invoiceRefNo).toBe((await submissionOf(sale.body.invoice.id)).irn);

    // A sale made before FBR was switched on has no FBR number, so its return is noted as not reported.
    const early = await setup({ fbr: false });
    const earlySale = await sell(early);
    const earlyLine = (await sqlRun((client) => client<{ id: string }[]>`SELECT id FROM sales_invoice_lines WHERE invoice_id = ${earlySale.body.invoice.id}`))[0].id;
    await callApi(early.business.ownerToken, "PUT", "/fbr/token", { body: { token: OK } });
    await callApi(early.business.ownerToken, "PUT", "/fbr/config", { body: { enabled: true, mode: "di", environment: "sandbox", sellerName: "X", sellerNtn: "1234567-8", sellerProvince: "SINDH", sellerAddress: "K", cancelWindowHours: 72, buyerIdThresholdPaisa: 5_000_000, confirmUntested: false } });
    const earlyBack = await callApi(early.business.ownerToken, "POST", "/returns", {
      ...early.as, idempotencyKey: key(),
      body: { shiftId: early.shiftId, invoiceId: earlySale.body.invoice.id, lines: [{ originalLineId: earlyLine, quantity: "1", restockTo: "sellable" }], refund: { methodId: early.methods.cash } },
    });
    expect(earlyBack.status, JSON.stringify(earlyBack.body)).toBe(201);
    expect(earlyBack.body.creditNote.fbrStatus).toBe("skipped");
  });

  it("the scheduled endpoints refuse everyone without the secret", async () => {
    const business = await createTestBusiness();
    expect((await job({ business }, null)).status).toBe(401);
    expect((await job({ business }, "not-the-secret-not-the-secret")).status).toBe(401);
    expect((await job({ business }, process.env.CRON_SECRET!, "GET")).status).toBe(200);
    expect((await job({ business }, process.env.CRON_SECRET!, "POST")).status).toBe(200);
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    expect((await job({ business }, "anything-at-all-anything")).status).toBe(503);
    process.env.CRON_SECRET = saved;
  });

  it("keeps the log: filtered, searchable, for the right people, with the record protected", async () => {
    const context = await setup();
    const accepted = await sell(context);
    await setToken(context, "mock-down");
    const waiting = await sell(context);
    await setToken(context, "mock-reject");
    const refused = await sell(context);
    const list = async (query: string, token = context.business.ownerToken) => (await callApi(token, "GET", `/fbr/submissions${query}`)).body;
    expect((await list("")).total).toBe(3);
    expect((await list("?status=accepted")).data.map((row: { number: string }) => row.number)).toEqual([accepted.body.invoice.number]);
    expect((await list("?status=pending")).data[0]).toMatchObject({ number: waiting.body.invoice.number, attempts: 1 });
    expect((await list("?status=attention")).data[0]).toMatchObject({ number: refused.body.invoice.number, status: "rejected" });
    expect((await list(`?q=${accepted.body.invoice.fbrIrn.slice(0, 10)}`)).total).toBe(1);
    expect((await list("?docType=sales_return")).total).toBe(0);
    expect((await list("?from=2020-01-01&to=2020-01-31")).total).toBe(0);
    expect((await callApi(context.business.ownerToken, "GET", "/fbr/summary")).body).toEqual({ pending: 1, rejected: 1, failed: 0, accepted: 1 });

    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await callApi(cashier.token, "GET", "/fbr/submissions")).status).toBe(403);
    const viewer = await inviteStaffWithPermissions(context.business, "FBR viewer", ["fbr.view"]);
    expect((await callApi(viewer.token, "GET", "/fbr/submissions")).status).toBe(200);
    const row = (await list("?status=attention")).data[0];
    expect((await callApi(viewer.token, "POST", `/fbr/submissions/${row.id}/retry`, { idempotencyKey: key() })).status).toBe(403);
    expect((await callApi((await createTestBusiness()).ownerToken, "GET", `/fbr/submissions/${row.id}`)).status).toBe(404);

    // History is history: an accepted invoice's number and the log of what was sent cannot be changed or removed.
    const id = (await list("?status=accepted")).data[0].id;
    const client = sql();
    await expect(client`UPDATE fbr_submissions SET irn = 'CHANGED' WHERE id = ${id}`).rejects.toThrow(/cannot be changed or reported again/);
    await expect(client`UPDATE fbr_submissions SET status = 'pending' WHERE id = ${id}`).rejects.toThrow(/cannot be changed or reported again/);
    await expect(client`DELETE FROM fbr_submissions WHERE id = ${id}`).rejects.toThrow(/cannot be deleted/);
    await expect(client`UPDATE fbr_attempts SET message = 'x' WHERE submission_id = ${id}`).rejects.toThrow(/append-only/);
    await expect(client`DELETE FROM fbr_attempts WHERE submission_id = ${id}`).rejects.toThrow(/append-only/);
    await expect(client`UPDATE sales_invoices SET fbr_irn = 'CHANGED' WHERE id = ${accepted.body.invoice.id}`).rejects.toThrow(/cannot be changed/);
    await expect(client`UPDATE sales_invoices SET total_paisa = 1 WHERE id = ${accepted.body.invoice.id}`).rejects.toThrow(/cannot be changed or deleted/);
    await expect(client`INSERT INTO fbr_submissions (business_id, doc_type, doc_id, number, channel, environment) VALUES (${context.business.businessId}, 'sales_invoice', ${accepted.body.invoice.id}, 'X', 'di', 'sandbox')`).rejects.toThrow(/duplicate key/);
    await client.end();
  }, 120_000);

  it("reconciles by day, flags the problems on the dashboard, and shows them only to those who may fix them", async () => {
    const context = await setup();
    await sell(context);
    await setToken(context, "mock-down");
    await sell(context);
    await setToken(context, "mock-reject");
    await sell(context);
    const report = (await callApi(context.business.ownerToken, "GET", "/report-data/fbr-reconciliation")).body;
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ posted: 3, accepted: 1, pending: 1, rejected: 1, failed: 0, not_reported: 0, returns_posted: 0 });
    expect(report.rows[0].tax_posted).toBe(report.rows[0].tax_accepted + report.rows[0].tax_outstanding);
    expect(report.rows[0].tax_outstanding).toBeGreaterThan(0);

    const board = (await callApi(context.business.ownerToken, "GET", "/dashboard")).body;
    expect(board.fbr).toEqual({ rejected: 1, failed: 0, pending: 1 });
    const salesOnly = await inviteStaffWithPermissions(context.business, "Sales viewer", ["reports.sales.view"]);
    expect((await callApi(salesOnly.token, "GET", "/dashboard")).body.fbr).toBeUndefined();
    expect((await callApi(salesOnly.token, "GET", "/report-data/fbr-reconciliation")).status).toBe(403);
  });
});
