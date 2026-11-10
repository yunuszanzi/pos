import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.6 slice 4 against the real UI, API and local Supabase: a challan is written, dispatched (stock leaves), delivered, and part comes back.

const key = () => `key-${crypto.randomUUID()}`;

test("3. a challan is written from an order, dispatched and delivered; the stock and the order follow, and a return puts it back", async ({ page }) => {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,100,Piece,1.00" }, idempotencyKey: key() });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const customer = await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Bilal Wholesale", phone: "0301-1111111" } });
  const placed = await callApi(business.ownerToken, "POST", "/sales-orders", {
    body: { customerId: customer.body.id, deliveryAddress: "Shop 9, Jodia Bazaar", lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity: "30" }] }, idempotencyKey: key(),
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const orderId = placed.body.order.id as string;

  await signInThroughUi(page, business.ownerEmail);
  await page.goto(`/sales-orders/${orderId}`);
  await page.getByRole("button", { name: "Write a delivery challan" }).click();
  const panel = page.getByRole("region", { name: "Write a delivery challan" });
  await expect(panel.getByLabel("Send now A")).toHaveValue("30");
  await panel.getByLabel("Send now A").fill("12");
  await panel.getByLabel("Driver").fill("Rafiq");
  await panel.getByLabel("Vehicle number").fill("KHI-1234");
  await panel.getByRole("button", { name: "Write challan" }).click();

  // Pending: nothing has left the shop yet.
  await expect(page.getByRole("heading", { name: /DC-.* — Pending/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "Challan items" })).toContainText("12");
  await page.goto("/stock");
  await expect(page.getByRole("row", { name: /Product A/ }).getByRole("cell").nth(2)).toContainText("100");

  // Dispatch: 88 on hand, the order is partly delivered, 18 are still held.
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Delivery challans", exact: true }).click();
  await page.getByRole("link", { name: /DC-/ }).first().click();
  await page.getByRole("button", { name: "Dispatch (stock leaves)" }).click();
  await expect(page.getByRole("heading", { name: /— Dispatched/ })).toBeVisible();
  await page.goto("/stock");
  await expect(page.getByRole("row", { name: /Product A/ }).getByRole("cell").nth(2)).toContainText("88");
  await expect(page.getByRole("row", { name: /Product A/ }).getByRole("cell").nth(3)).toContainText("70");
  await page.goto(`/sales-orders/${orderId}`);
  await expect(page.getByRole("heading", { name: /— Partly delivered/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "Challans for this order" })).toContainText("Dispatched");
  // The challan cannot be dispatched twice: its button is gone.
  await page.getByRole("link", { name: /DC-/ }).first().click();
  await expect(page.getByRole("button", { name: "Dispatch (stock leaves)" })).toHaveCount(0);

  // The customer receives it, then the whole trip comes back (a return covers the whole challan).
  await page.getByRole("button", { name: "Customer received it" }).click();
  await expect(page.getByRole("heading", { name: /— Delivered/ })).toBeVisible();
  await page.getByRole("button", { name: "Goods came back" }).click();
  await expect(page.getByRole("button", { name: "Goods came back" }).first()).toBeDisabled();
  await page.getByLabel("Why did the goods come back?").fill("Wrong colour");
  await page.getByRole("button", { name: "Goods came back" }).first().click();
  await expect(page.getByRole("heading", { name: /— Returned/ })).toBeVisible();
  await page.goto("/stock");
  await expect(page.getByRole("row", { name: /Product A/ }).getByRole("cell").nth(2)).toContainText("100");
  await page.goto(`/sales-orders/${orderId}`);
  await expect(page.getByRole("heading", { name: /— Open/ })).toBeVisible();
});
