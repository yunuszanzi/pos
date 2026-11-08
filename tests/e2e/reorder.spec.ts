import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, firstLocationId, sql } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.5 slice 5 against the real UI, API and local Supabase: the reorder list, draft orders, and what a SKU cost last time.

test("5. low stock is listed, becomes a draft order for its usual supplier, and the order form recalls the last price", async ({ page }) => {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 500);
  const client = sql();
  await client`UPDATE product_variants SET reorder_level = '50', reorder_quantity = '200' WHERE id = ${product.variantId}`;
  await client.end();
  const supplier = await callApi(business.ownerToken, "POST", "/suppliers", { body: { name: "Karachi Balloon Mills", phone: "0300-1112222" } });
  expect(supplier.status).toBe(201);
  // 10 pieces arrive from them at Rs 12.00: that is low (level 50), and it is who they are bought from.
  const received = await callApi(business.ownerToken, "POST", "/goods-receipts", {
    idempotencyKey: `rcv-${crypto.randomUUID()}`,
    body: { supplierId: supplier.body.id, locationId: await firstLocationId(business), lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity: "10", unitCostPaisa: 1_200 }] },
  });
  expect(received.status, JSON.stringify(received.body)).toBe(201);

  await signInThroughUi(page, business.ownerEmail);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Reorder list", exact: true }).click();

  const table = page.getByRole("table", { name: "Reorder list" });
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table).toContainText("Product A");
  await expect(table).toContainText("last bought at Rs 12.00 a piece");
  await expect(page.getByLabel("Quantity of A to order")).toHaveValue("200");
  await expect(page.getByLabel("Supplier for A")).toHaveText(/Karachi Balloon Mills/);
  await expect(page.getByRole("link", { name: "Share on WhatsApp" })).toHaveAttribute("href", /^https:\/\/wa\.me\/\?text=/);

  // The quantity box takes digits only.
  await page.getByLabel("Quantity of A to order").fill("2x5y0");
  await expect(page.getByLabel("Quantity of A to order")).toHaveValue("250");
  await page.getByLabel("Quantity of A to order").fill("200");

  // Nothing is made until an item is ticked; then one draft order per supplier.
  await expect(page.getByRole("button", { name: "Make draft orders (0)" })).toBeDisabled();
  await page.getByLabel("Order A", { exact: true }).check();
  await page.getByRole("button", { name: "Make draft orders (1)" }).click();
  await expect(page.getByText(/Made 1 draft order:/)).toBeVisible();
  await expect(page.getByText(/Karachi Balloon Mills, 1 item, Rs 2,400.00/)).toBeVisible();
  await page.getByRole("link", { name: /^PO-/ }).click();
  await expect(page.getByRole("heading", { name: /Draft/ })).toBeVisible();
  await expect(page.getByTestId("order-total")).toHaveText("Rs 2,400.00");

  // A new order recalls what it cost last time, and starts from that price.
  await nav.getByRole("link", { name: "Purchase orders", exact: true }).click();
  await page.getByRole("link", { name: "New purchase order" }).click();
  await page.getByLabel("Find a product to add").fill("A");
  await page.getByRole("button", { name: "Add A" }).click();
  await expect(page.getByTestId("last-bought-A")).toContainText("Last bought Rs 12.00 a piece from Karachi Balloon Mills");
  await expect(page.getByRole("group", { name: "Line A" }).getByLabel("Price of one unit (Rs)")).toHaveValue("12.00");
});
