import { businessToday } from "../../shared/dates";
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, inviteStaffWithPermissions, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;
const inDays = (days: number) => new Date(Date.parse(businessToday()) + days * 86_400_000).toISOString().slice(0, 10);

// v0.6 slice 7 against the real API and database: share a document by link (FR-PRT-07).

async function setup() {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,100,Piece,1.00" }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const customer = await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Bilal Wholesale", phone: "0301-1111111", ntn: "7654321-1", termsDays: 15, creditLimitPaisa: 10_000_000 } });
  const quote = await callApi(business.ownerToken, "POST", "/quotations", {
    body: { customerId: customer.body.id, validUntil: inDays(14), terms: "50% advance", lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity: "10" }] },
  });
  expect(quote.status, JSON.stringify(quote.body)).toBe(201);
  return { business, product, customerId: customer.body.id as string, quote: quote.body };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** A request with no sign-in at all, straight at the public route. */
const openLink = async (token: string) => {
  const { app } = await import("../../server/app");
  const response = await app.fetch(new Request(`http://localhost/api/public/documents/${token}`));
  return { status: response.status, body: await response.json() as Record<string, any>, headers: response.headers };
};
const share = (context: Setup, type: string, id: string, token = context.business.ownerToken) => callApi(token, "POST", "/document-shares", { body: { type, id } });

integration("sharing documents by link", { timeout: 300_000 }, () => {
  it("acceptance 3: a quotation link opens without signing in, and shows the quotation and the business", async () => {
    const context = await setup();
    const made = await share(context, "quotation", context.quote.id);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.path).toBe(`/d/${made.body.token}`);
    expect(made.body.token.length).toBeGreaterThanOrEqual(40);
    expect(new Date(made.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const opened = await openLink(made.body.token);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ type: "quotation", dateFormat: expect.any(String), timezone: expect.any(String) });
    expect(opened.body.document).toMatchObject({ id: context.quote.id, number: context.quote.number, totalPaisa: 5_000, terms: "50% advance", customerName: "Bilal Wholesale" });
    expect(opened.body.business).toMatchObject({ tradeName: "Example Traders" });
    expect(opened.headers.get("cache-control")).toBe("no-store");

    // Asking again for the same document gives the same link; each opening is counted.
    const again = await share(context, "quotation", context.quote.id);
    expect(again.status).toBe(200);
    expect(again.body.token).toBe(made.body.token);
    await openLink(made.body.token);
    const client = sql();
    const [row] = await client<{ view_count: number }[]>`SELECT view_count FROM document_shares WHERE token = ${made.body.token}`;
    await client.end();
    expect(row.view_count).toBe(2);
  });

  it("an unknown, malformed, revoked or expired link all answer the same 404", async () => {
    const context = await setup();
    const made = (await share(context, "quotation", context.quote.id)).body;
    const unknown = await openLink("A".repeat(43));
    const malformed = await openLink("short");
    expect([unknown.status, malformed.status]).toEqual([404, 404]);
    expect(unknown.body.error.message).toBe(malformed.body.error.message);

    const revoked = await callApi(context.business.ownerToken, "POST", "/document-shares/revoke", { body: { type: "quotation", id: context.quote.id } });
    expect(revoked.body).toEqual({ revoked: 1 });
    const gone = await openLink(made.token);
    expect(gone.status).toBe(404);
    expect(gone.body.error.message).toBe(unknown.body.error.message);

    // A new link is made after revoking, and it works; then it expires.
    const fresh = (await share(context, "quotation", context.quote.id)).body;
    expect(fresh.token).not.toBe(made.token);
    expect((await openLink(fresh.token)).status).toBe(200);
    const client = sql();
    await client`UPDATE document_shares SET expires_at = now() - interval '1 minute' WHERE token = ${fresh.token}`;
    await client.end();
    expect((await openLink(fresh.token)).status).toBe(404);
    // A link about to expire is replaced rather than handed out again.
    const client2 = sql();
    const renewed = (await share(context, "quotation", context.quote.id)).body;
    await client2`UPDATE document_shares SET expires_at = now() + interval '2 hours' WHERE token = ${renewed.token}`;
    await client2.end();
    expect((await share(context, "quotation", context.quote.id)).body.token).not.toBe(renewed.token);
  });

  it("shares orders, challans and invoices too, with no costs in any of them", async () => {
    const context = await setup();
    const order = (await callApi(context.business.ownerToken, "POST", "/sales-orders", { idempotencyKey: key(), body: { customerId: context.customerId, lines: [{ variantId: context.product.variantId, unitId: context.product.pieceId, quantity: "10" }] } })).body.order;
    const challan = (await callApi(context.business.ownerToken, "POST", "/delivery-challans", { idempotencyKey: key(), body: { orderId: order.id } })).body.challan;
    await callApi(context.business.ownerToken, "POST", `/delivery-challans/${challan.id}/dispatch`, { idempotencyKey: key(), body: {} });
    const invoice = (await callApi(context.business.ownerToken, "POST", "/sales-invoices", { idempotencyKey: key(), body: { orderId: order.id } })).body.invoice;
    expect(invoice.lines[0].costPaisa).toBe(100); // the owner sees the cost on their own screen

    for (const [type, id] of [["sales_order", order.id], ["delivery_challan", challan.id], ["invoice", invoice.id]] as const) {
      const made = await share(context, type, id);
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const opened = await openLink(made.body.token);
      expect(opened.status).toBe(200);
      expect(opened.body.type).toBe(type);
      expect(JSON.stringify(opened.body)).not.toMatch(/costPaisa|avgCost|cost_paisa/);
    }
    const sharedInvoice = (await openLink((await share(context, "invoice", invoice.id)).body.token)).body.document;
    expect(sharedInvoice).toMatchObject({ number: invoice.number, totalPaisa: 5_000, outstandingPaisa: 5_000, buyerNtn: "7654321-1", channel: "back_office" });
  });

  it("only someone who may see a document can link it, and only within their own business", async () => {
    const context = await setup();
    const cashier = await inviteTestStaff(context.business, "Cashier");
    expect((await share(context, "quotation", context.quote.id, cashier.token)).status).toBe(403);
    const writer = await inviteStaffWithPermissions(context.business, "Quote reader", ["quotations.view"]);
    expect((await share(context, "quotation", context.quote.id, writer.token)).status).toBe(201);
    expect((await share(context, "invoice", context.quote.id, writer.token)).status).toBe(403);
    expect((await callApi(writer.token, "POST", "/document-shares/revoke", { body: { type: "quotation", id: context.quote.id } })).status).toBe(200);

    // Another business cannot link this one's quotation.
    const other = await createTestBusiness();
    const stolen = await callApi(other.ownerToken, "POST", "/document-shares", { body: { type: "quotation", id: context.quote.id } });
    expect(stolen.status).toBe(404);
    expect((await callApi(other.ownerToken, "POST", "/document-shares", { body: { type: "quotation", id: crypto.randomUUID() } })).status).toBe(404);
    expect((await callApi(other.ownerToken, "POST", "/document-shares", { body: { type: "nonsense", id: context.quote.id } })).status).toBe(400);
  });
});
