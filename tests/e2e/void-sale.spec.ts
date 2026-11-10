import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// FR-SAL-10 through the till: cancelling a sale before payment needs a reason and is logged.

test("a cashier cancels a sale: the reason is asked for, the cart empties, and the log records it", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "VOID-A", 100);
  expect((await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nVOID-A,10,Piece,1.00" }, idempotencyKey: `open-${crypto.randomUUID()}` })).status).toBe(201);
  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Point of sale" }).click();
  await page.getByLabel("Opening cash (Rs)").fill("0.00");
  await page.getByRole("button", { name: "Open shift" }).click();
  await expect(page.getByRole("button", { name: /Product / }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");

  const box = page.getByLabel("Scan or search");
  await box.fill("3*VOID-A-PC");
  await box.press("Enter");
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 15.00");

  await page.getByRole("button", { name: "Cancel sale" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this sale" });
  await expect(dialog).toContainText("Rs 15.00");
  // "Other" needs words of its own.
  await dialog.getByLabel("Why?").selectOption("Other");
  await expect(dialog.getByRole("button", { name: "Cancel the sale" })).toBeDisabled();
  await dialog.getByLabel("Say why").fill("Customer left the queue");
  await dialog.getByRole("button", { name: "Cancel the sale" }).click();
  await expect(page.getByText("Sale cancelled and logged")).toBeVisible();
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 0.00");

  const log = await callApi(business.ownerToken, "GET", "/audit-log?pageSize=100");
  const entry = log.body.data.find((row: { entity: string; action: string }) => row.entity === "sale" && row.action === "void");
  expect(entry.after).toMatchObject({ reason: "Customer left the queue", totalPaisa: 1500, lines: [{ sku: "VOID-A", quantity: "3" }] });
});
