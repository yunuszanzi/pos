import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, sql } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.6 slice 3 against the real UI, API and local Supabase: part of a quotation becomes an order at the quoted price, and the stock is held.

const key = () => `key-${crypto.randomUUID()}`;
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

test("2. a quotation is ordered in two parts at the quoted price, and each order holds its stock", async ({ page }) => {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,100,Piece,1.00" }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const customer = await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Bilal Wholesale", phone: "0301-1111111" } });
  const made = await callApi(business.ownerToken, "POST", "/quotations", {
    body: { customerId: customer.body.id, validUntil: inDays(14), lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity: "10" }] },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  await callApi(business.ownerToken, "POST", `/quotations/${made.body.id}/send`, { idempotencyKey: key() });

  // The shelf price doubles after the quotation went out.
  const client = sql();
  await client`UPDATE product_units SET sale_price_paisa = 1000 WHERE variant_id = ${product.variantId} AND unit_id = ${product.pieceId}`;
  await client.end();

  await signInThroughUi(page, business.ownerEmail);
  await page.goto(`/quotations/${made.body.id}`);
  await page.getByRole("button", { name: "Make a sales order" }).click();
  const panel = page.getByRole("region", { name: "Make a sales order" });
  await expect(panel.getByLabel("Order now A")).toHaveValue("10");
  await panel.getByLabel("Order now A").fill("4");
  await panel.getByLabel("Customer's PO number").fill("PO-77");
  await panel.getByRole("button", { name: "Create sales order" }).click();

  // 4 of the 10 at the quoted Rs 5.00, not the new Rs 10.00.
  await expect(page.getByRole("heading", { name: /SO-.* — Open/ })).toBeVisible();
  await expect(page.getByTestId("order-total")).toHaveText("Rs 20.00");
  await expect(page.getByRole("table", { name: "Order items" })).toContainText("Rs 5.00");

  // The stock list: 100 on hand, 96 available.
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Stock", exact: true }).click();
  const row = page.getByRole("row", { name: /Product A/ });
  await expect(row.getByRole("cell").nth(2)).toContainText("100");
  await expect(row.getByRole("cell").nth(3)).toContainText("96");

  // The quotation is still open for the other 6; ordering them completes it.
  await page.goto(`/quotations/${made.body.id}`);
  await expect(page.getByRole("heading", { name: /— Sent/ })).toBeVisible();
  await page.getByRole("button", { name: "Make a sales order" }).click();
  await expect(page.getByLabel("Order now A")).toHaveValue("6");
  await page.getByRole("button", { name: "Create sales order" }).click();
  await expect(page.getByTestId("order-total")).toHaveText("Rs 30.00");
  await page.goto(`/quotations/${made.body.id}`);
  await expect(page.getByRole("heading", { name: /— Converted/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Make a sales order" })).toHaveCount(0);

  // Both orders are listed, and cancelling the newer one (6 pieces) frees its stock: 4 are still held, so 96 are available.
  await page.goto("/sales-orders");
  await expect(page.getByRole("table", { name: "Sales orders" }).getByRole("row")).toHaveCount(3);
  await page.getByRole("table", { name: "Sales orders" }).getByRole("link").first().click();
  await page.getByRole("button", { name: "Cancel order" }).click();
  await expect(page.getByRole("heading", { name: /Cancelled/ })).toBeVisible();
  await page.goto("/stock");
  await expect(page.getByRole("row", { name: /Product A/ }).getByRole("cell").nth(3)).toContainText("96");
});
