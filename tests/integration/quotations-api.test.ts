// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

// v0.6 slice 1 against the real API and database: quotations (FR-QUO-01..05).

async function setup() {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  return { business, product };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const body = (context: Setup, extra: Record<string, unknown> = {}) => ({
  prospectName: "Ali Traders", prospectPhone: "0300-1234567", validUntil: inDays(14), terms: "50% advance",
  lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "10" }], ...extra,
});
const create = (context: Setup, extra: Record<string, unknown> = {}) => callApi(context.business.ownerToken, "POST", "/quotations", { body: body(context, extra) });
const act = (context: Setup, id: string, action: string) => callApi(context.business.ownerToken, "POST", `/quotations/${id}/${action}`, { idempotencyKey: key() });

integration("quotations", { timeout: 240_000 }, () => {
  it("makes a draft for a prospect with the shelf price, and touches neither stock nor the ledger", async () => {
    const context = await setup();
    const made = await create(context);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ status: "draft", revisionNo: 1, isProspect: true, customerName: "Ali Traders", totalPaisa: 5_000, terms: "50% advance" });
    expect(made.body.number).toMatch(/^QUO-[A-Z0-9]+-\d{6}$/);
    expect(made.body.lines[0]).toMatchObject({ quantity: "10", unitPricePaisa: 500, totalPaisa: 5_000 });

    const client = sql();
    const [{ moves }] = await client<{ moves: string }[]>`SELECT count(*)::text AS moves FROM stock_ledger WHERE business_id = ${context.business.businessId}`;
    const [{ entries }] = await client<{ entries: string }[]>`SELECT count(*)::text AS entries FROM party_ledger WHERE business_id = ${context.business.businessId}`;
    await client.end();
    expect([moves, entries]).toEqual(["0", "0"]);
  });

  it("needs a customer or a prospect name, and a valid date", async () => {
    const context = await setup();
    expect((await create(context, { prospectName: "" })).status).toBe(400);
    const past = await create(context, { validUntil: inDays(-1) });
    expect(past.status).toBe(422);
    expect(past.body.error.code).toBe("INVALID_DATE");
  });

  it("a draft can be changed; a sent quotation cannot, and is revised instead (FR-QUO-05)", async () => {
    const context = await setup();
    const draft = (await create(context)).body;
    const changed = await callApi(context.business.ownerToken, "PUT", `/quotations/${draft.id}`, {
      body: body(context, { lines: [{ variantId: context.product.variantId, unitId: context.product.cartonId, quantity: "2" }] }),
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ number: draft.number, totalPaisa: 180_000 });

    expect((await act(context, draft.id, "send")).body.status).toBe("sent");
    const edit = await callApi(context.business.ownerToken, "PUT", `/quotations/${draft.id}`, { body: body(context) });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("QUOTATION_NOT_EDITABLE");

    const revised = await act(context, draft.id, "revise");
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
    expect(revised.body).toMatchObject({ number: draft.number, revisionNo: 2, status: "draft", totalPaisa: 180_000 });
    expect(revised.body.revisions.map((revision: { revisionNo: number; status: string }) => [revision.revisionNo, revision.status])).toEqual([[1, "revised"], [2, "draft"]]);
    const old = (await callApi(context.business.ownerToken, "GET", `/quotations/${draft.id}`)).body;
    expect(old).toMatchObject({ status: "revised", supersededBy: revised.body.id });
    // A revised one is history: it cannot be accepted, and the working list shows only the latest.
    expect((await act(context, draft.id, "accept")).status).toBe(409);
    const list = await callApi(context.business.ownerToken, "GET", "/quotations");
    expect(list.body.data.map((row: { revisionNo: number }) => row.revisionNo)).toEqual([2]);
  });

  it("moves through sent, accepted and rejected, and refuses a jump", async () => {
    const context = await setup();
    const quote = (await create(context)).body;
    expect((await act(context, quote.id, "accept")).status).toBe(409);
    expect((await act(context, quote.id, "send")).body.status).toBe("sent");
    expect((await act(context, quote.id, "accept")).body.status).toBe("accepted");
    expect((await act(context, quote.id, "reject")).body.status).toBe("rejected");
    expect((await act(context, quote.id, "send")).status).toBe(409);
  });

  it("a sent quotation past its validity date reads as expired and cannot be accepted", async () => {
    const context = await setup();
    const quote = (await create(context)).body;
    await act(context, quote.id, "send");
    const client = sql();
    // Time travel for the test: the protection trigger is off for this one statement.
    await client.begin(async (tx) => {
      await tx`ALTER TABLE quotations DISABLE TRIGGER quotations_protect`;
      await tx`UPDATE quotations SET quote_date = current_date - 20, valid_until = current_date - 5 WHERE id = ${quote.id}`;
      await tx`ALTER TABLE quotations ENABLE TRIGGER quotations_protect`;
    });
    await client.end();
    expect((await callApi(context.business.ownerToken, "GET", `/quotations/${quote.id}`)).body.status).toBe("expired");
    const accept = await act(context, quote.id, "accept");
    expect(accept.status).toBe(409);
    expect(accept.body.error.code).toBe("QUOTATION_EXPIRED");
    const expired = await callApi(context.business.ownerToken, "GET", "/quotations?status=expired");
    expect(expired.body.data).toHaveLength(1);
    // It can be revised with a new date.
    const revised = await act(context, quote.id, "revise");
    expect(revised.status).toBe(201);
    expect(revised.body.validUntil >= inDays(6)).toBe(true);
  });

  it("acceptance 1 (so far): a quotation keeps its prices after the price list changes", async () => {
    const context = await setup();
    const quote = (await create(context)).body;
    await act(context, quote.id, "send");
    await act(context, quote.id, "accept");
    const client = sql();
    await client`UPDATE product_units SET sale_price_paisa = 900 WHERE variant_id = ${context.product.variantId} AND unit_id = ${context.product.pieceId}`;
    await client.end();
    const later = (await callApi(context.business.ownerToken, "GET", `/quotations/${quote.id}`)).body;
    expect(later).toMatchObject({ status: "accepted", totalPaisa: 5_000 });
    expect(later.lines[0].unitPricePaisa).toBe(500);
    // A new quotation picks up the new price.
    expect((await create(context)).body.totalPaisa).toBe(9_000);
  });

  it("quotes a registered customer at their tier price and works out discounts and tax", async () => {
    const context = await setup();
    const customer = await callApi(context.business.ownerToken, "POST", "/customers", { body: { name: "Bilal Wholesale", phone: "0301-1111111" } });
    expect(customer.status, JSON.stringify(customer.body)).toBe(201);
    const made = await create(context, {
      customerId: customer.body.id, prospectName: "",
      lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "10", discount: { type: "percent", bps: 1000 } }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ isProspect: false, customerName: "Bilal Wholesale", lineDiscountPaisa: 500, totalPaisa: 4_500 });
    // A customer is findable by name.
    const found = await callApi(context.business.ownerToken, "GET", "/quotations?q=bilal");
    expect(found.body.total).toBe(1);
  });

  it("refuses a changed price without the permission, and anyone without quotation permissions", async () => {
    const context = await setup();
    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await callApi(cashier.token, "GET", "/quotations")).status).toBe(403);
    expect((await callApi(cashier.token, "POST", "/quotations", { body: body(context) })).status).toBe(403);

    const writer = await inviteStaffWithPermissions(context.business, "Quote writer", ["quotations.view", "quotations.manage", "sales.discount", "catalog.view"]);
    const priced = await callApi(writer.token, "POST", "/quotations", {
      body: body(context, { lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "1", unitPricePaisa: 100 }] }),
    });
    expect(priced.status).toBe(403);
    expect(priced.body.error.code).toBe("PRICE_OVERRIDE_DENIED");
    expect((await callApi(writer.token, "POST", "/quotations", { body: body(context) })).status).toBe(201);
  });

  it("a sent quotation is protected in the database, even from direct writes", async () => {
    const context = await setup();
    const quote = (await create(context)).body;
    await act(context, quote.id, "send");
    const client = sql();
    await expect(client`UPDATE quotations SET terms = 'changed' WHERE id = ${quote.id}`).rejects.toThrow(/cannot be changed/);
    await expect(client`DELETE FROM quotation_lines WHERE quotation_id = ${quote.id}`).rejects.toThrow(/cannot be changed/);
    await client.end();
  });
});
