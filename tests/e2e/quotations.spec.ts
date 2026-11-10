import { expect, test } from "@playwright/test";
import { createSimpleProduct, createTestBusiness, sql } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.6 slice 2 against the real UI, API and local Supabase: a quotation is written for a prospect, sent, revised and accepted.

test("1. a quotation is written, sent, revised and accepted, and keeps its price when the shelf price changes", async ({ page }) => {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);

  await signInThroughUi(page, business.ownerEmail);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Quotations", exact: true }).click();
  await page.getByRole("link", { name: "New quotation" }).click();

  // A prospect, 10 pieces at the shelf price (Rs 5.00), a 10% discount.
  await page.getByLabel("Or a prospect's name").fill("Ali Traders");
  await page.getByLabel("Prospect's phone").fill("0300-1234567");
  await page.getByLabel("Terms").fill("50% advance");
  await page.getByLabel("Find a product to add").fill("A");
  await page.getByRole("button", { name: "Add A" }).click();
  const line = page.getByRole("group", { name: "Line A" });
  await line.getByLabel("Quantity").pressSequentially("1x0"); // letters never appear
  await expect(line.getByLabel("Quantity")).toHaveValue("10");
  await line.getByLabel("Discount (%)").fill("10");
  await expect(page.getByTestId("quotation-estimate")).toHaveText("Rs 45.00");
  await page.getByRole("button", { name: "Save quotation" }).click();

  // A draft until sent; it cannot be accepted yet.
  await expect(page.getByRole("heading", { name: /Draft/ })).toBeVisible();
  await expect(page.getByTestId("quotation-total")).toHaveText("Rs 45.00");
  await expect(page.getByRole("button", { name: "Customer accepted" })).toHaveCount(0);
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await expect(page.getByRole("heading", { name: /Sent/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Change quotation" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Share on WhatsApp" })).toHaveAttribute("href", /wa\.me\/923001234567/);

  // Change after sending means a new revision with the same number: 20 pieces now.
  await page.getByRole("button", { name: "Revise (new revision)" }).click();
  await expect(page.getByRole("heading", { name: /Change QUO-.* Rev 2/ })).toBeVisible();
  await page.getByRole("group", { name: "Line A" }).getByLabel("Quantity").fill("20");
  await page.getByRole("button", { name: "Save quotation" }).click();
  await expect(page.getByTestId("quotation-total")).toHaveText("Rs 90.00");
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await page.getByRole("button", { name: "Customer accepted" }).click();
  await expect(page.getByRole("heading", { name: /Accepted/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "Revisions" }).getByRole("row")).toHaveCount(3);

  // The shelf price goes up; the accepted quotation still says Rs 90.00.
  const client = sql();
  await client`UPDATE product_units SET sale_price_paisa = 900 WHERE variant_id = ${product.variantId} AND unit_id = ${product.pieceId}`;
  await client.end();
  await page.reload();
  await expect(page.getByTestId("quotation-total")).toHaveText("Rs 90.00");
  await expect(page.getByRole("table", { name: "Quotation items" })).toContainText("Rs 5.00");

  // The list shows the latest revision only.
  await nav.getByRole("link", { name: "Quotations", exact: true }).click();
  await page.getByLabel("Show").selectOption("accepted");
  await expect(page.getByRole("table", { name: "Quotations" }).getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("table", { name: "Quotations" })).toContainText("Rev 2");
});
