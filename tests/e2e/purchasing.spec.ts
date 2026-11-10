import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.5 slice 2 against the real UI, API and local Supabase: an order is written and sent, and its goods arrive in two parts.

test("2. a purchase order is sent and received in two parts, and stock and average cost follow", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "A", 100);
  const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,100,Piece,10.00" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  const supplier = await callApi(business.ownerToken, "POST", "/suppliers", { body: { name: "Karachi Balloon Mills", phone: "0300-1112222" } });
  expect(supplier.status).toBe(201);

  await signInThroughUi(page, business.ownerEmail);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Purchase orders", exact: true }).click();
  await page.getByRole("link", { name: "New purchase order" }).click();

  // Write the order: 100 pieces at Rs 12.00.
  await page.getByLabel("Find a supplier").fill("Karachi");
  await page.getByRole("button", { name: /Karachi Balloon Mills/ }).click();
  await page.getByLabel("Find a product to add").fill("A");
  await page.getByRole("button", { name: "Add A" }).click();
  const line = page.getByRole("group", { name: "Line A" });
  await line.getByLabel("Quantity").pressSequentially("1x0y0"); // letters never appear
  await expect(line.getByLabel("Quantity")).toHaveValue("100");
  await line.getByLabel("Price of one unit (Rs)").fill("12.00");
  await expect(page.getByTestId("order-total")).toHaveText("Rs 1,200.00");
  await page.getByRole("button", { name: "Save order" }).click();

  // It is a draft until it is sent; only then can goods be received.
  await expect(page.getByRole("heading", { name: /Draft/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Receive goods" })).toHaveCount(0);
  await page.getByRole("button", { name: "Send to supplier" }).click();
  await expect(page.getByRole("heading", { name: /Sent/ })).toBeVisible();

  // 60 arrive: stock 160, average (100 x 10.00 + 60 x 12.00) / 160 = 10.75.
  await page.getByRole("link", { name: "Receive goods" }).click();
  await page.getByRole("group", { name: "Line A" }).getByLabel(/^Received/).fill("60");
  await page.getByLabel("Supplier's challan or invoice number").fill("DC-1");
  await page.getByRole("button", { name: "Receive goods" }).click();
  await expect(page.getByTestId("on-hand-A")).toHaveText("160");
  await expect(page.getByRole("table", { name: "Stock now" })).toContainText("Rs 10.75");
  await expect(page.getByTestId("receipt-total")).toHaveText("Rs 720.00");
  await page.getByRole("link", { name: "Back to the order" }).click();
  await expect(page.getByRole("heading", { name: /Partly received/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "Order items" })).toContainText("40"); // still to come

  // The other 40 arrive (the box offers what is left): stock 200, average (160 x 10.75 + 40 x 12.00) / 200 = 11.00.
  await page.getByRole("link", { name: "Receive goods" }).click();
  await expect(page.getByRole("group", { name: "Line A" }).getByLabel(/^Received/)).toHaveValue("40");
  await page.getByRole("button", { name: "Receive goods" }).click();
  await expect(page.getByTestId("on-hand-A")).toHaveText("200");
  await expect(page.getByRole("table", { name: "Stock now" })).toContainText("Rs 11.00");
  await page.getByRole("link", { name: "Back to the order" }).click();
  await expect(page.getByRole("heading", { name: /— Received/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "Receipts for this order" }).getByRole("row")).toHaveCount(3);

  // Both receipts are listed, and a completed order takes no more goods.
  await nav.getByRole("link", { name: "Goods receipts", exact: true }).click();
  await expect(page.getByRole("table", { name: "Goods receipts" }).getByRole("row")).toHaveCount(3);
  await expect(page.getByRole("table", { name: "Goods receipts" })).toContainText("DC-1");
  await expect(page.getByRole("table", { name: "Goods receipts" }).getByRole("link", { name: /GRN-/ }).first()).toBeVisible();
});
