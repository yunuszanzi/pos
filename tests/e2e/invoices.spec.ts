import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.6 slice 5 against the real UI, API and local Supabase: delivered goods are invoiced with terms, and a direct invoice takes the stock.

const key = () => `key-${crypto.randomUUID()}`;

test("4. delivered goods are invoiced from the order as a tax invoice with terms, and a direct invoice sends the goods out", async ({ page }) => {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,100,Piece,1.00" }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const customer = await callApi(business.ownerToken, "POST", "/customers", {
    body: { name: "Bilal Wholesale", businessName: "Bilal Traders", phone: "0301-1111111", ntn: "7654321-1", registered: true, termsDays: 15, creditLimitPaisa: 10_000_000 },
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  const placed = await callApi(business.ownerToken, "POST", "/sales-orders", {
    body: { customerId: customer.body.id, customerPo: "PO-77", lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity: "30" }] }, idempotencyKey: key(),
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const orderId = placed.body.order.id as string;
  const challan = await callApi(business.ownerToken, "POST", "/delivery-challans", { body: { orderId, lines: [{ orderLineId: placed.body.order.lines[0].id, quantity: "12" }] }, idempotencyKey: key() });
  expect((await callApi(business.ownerToken, "POST", `/delivery-challans/${challan.body.challan.id}/dispatch`, { body: {}, idempotencyKey: key() })).status).toBe(200);

  // Bill the 12 that went out, on 30 days.
  await signInThroughUi(page, business.ownerEmail);
  await page.goto(`/sales-orders/${orderId}`);
  await page.getByRole("button", { name: "Make an invoice" }).click();
  const panel = page.getByRole("region", { name: "Make an invoice" });
  await expect(panel.getByLabel("Bill now A")).toHaveValue("12");
  await panel.getByLabel("Payment terms").selectOption("30");
  await panel.getByRole("button", { name: "Post invoice" }).click();

  await expect(page.getByRole("heading", { name: /INV-.* — Tax invoice/ })).toBeVisible();
  await expect(page.getByTestId("invoice-total")).toHaveText("Rs 60.00");
  await expect(page.getByTestId("invoice-owing")).toHaveText("Rs 60.00");
  await expect(page.getByText("NTN 7654321-1")).toBeVisible();
  await expect(page.getByText("30 days")).toBeVisible();
  await expect(page.getByRole("link", { name: "Receive a payment (khata)" })).toBeVisible();

  // The order shows its invoice, and nothing more is billable until more is delivered.
  await page.goto(`/sales-orders/${orderId}`);
  await expect(page.getByRole("table", { name: "Invoices for this order" }).getByRole("link")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Make an invoice" })).toHaveCount(0);

  // A direct invoice: 10 pieces go out with it. 100 - 12 delivered = 88 on hand, 18 held; 10 more leave: 78 on hand.
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Invoices", exact: true }).click();
  await expect(page.getByRole("table", { name: "Invoices" }).getByRole("row")).toHaveCount(2);
  await page.getByRole("link", { name: "New invoice" }).click();
  await page.getByLabel("Find a customer").fill("Bilal");
  await page.getByRole("button", { name: /Bilal Wholesale/ }).click();
  await page.getByLabel("Find a product to add").fill("A");
  await page.getByRole("button", { name: "Add A" }).click();
  await page.getByRole("group", { name: "Line A" }).getByLabel("Quantity").fill("10");
  await page.getByLabel("Payment terms").selectOption("0");
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByTestId("invoice-total")).toHaveText("Rs 50.00");
  await expect(page.getByText("Due on receipt")).toBeVisible();
  await page.goto("/stock");
  await expect(page.getByRole("row", { name: /Product A/ }).getByRole("cell").nth(2)).toContainText("78", { timeout: 20_000 });
  await expect(page.getByRole("row", { name: /Product A/ }).getByRole("cell").nth(3)).toContainText("60", { timeout: 20_000 });

  // Both invoices are still owing; the customer's khata shows the total.
  await page.goto("/invoices");
  await expect(page.getByRole("table", { name: "Invoices" }).getByRole("row")).toHaveCount(3);
  await page.goto(`/customers/${customer.body.id}/ledger`);
  await expect(page.getByText("Rs 110.00").first()).toBeVisible();
});
