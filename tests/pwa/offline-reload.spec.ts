import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, sql } from "../integration/helpers";
import { signInThroughUi } from "../e2e/helpers";

// The production build with its service worker (technical plan 5.5): a till that has been opened once can be opened again with the
// network unplugged, and keeps selling. This is the only test that runs the real build; the rest of the browser tests use the dev server.

test("a till that was open before the network went can be reloaded offline and still sells; the sale is sent when the network is back", async ({ page, context }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "PWA-A", 100);
  expect((await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nPWA-A,50,Piece,1.00" }, idempotencyKey: `open-${crypto.randomUUID()}` })).status).toBe(201);

  await signInThroughUi(page, business.ownerEmail);
  await page.goto("/pos");
  await page.getByLabel("Opening cash (Rs)").fill("0.00");
  await page.getByRole("button", { name: "Open shift" }).click();
  await expect(page.getByLabel("Scan or search")).toBeVisible();
  await expect(page.getByRole("button", { name: /Product / }).first()).toBeVisible();

  // The service worker installs after the first load and takes over; one more online visit lets it keep the page's files.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 });
  await page.reload();
  await expect(page.getByLabel("Scan or search")).toBeVisible();
  await expect(page.getByRole("button", { name: /Product / }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");

  // The network goes. The page is reloaded cold: it must open from what the device kept.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByLabel("Scan or search")).toBeVisible();
  await expect(page.getByTestId("till-offline")).toBeVisible();
  await expect(page.getByRole("button", { name: /Product / }).first()).toBeVisible();

  const box = page.getByLabel("Scan or search");
  await box.fill("PWA-A-PC");
  await box.press("Enter");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByLabel("Amount 1").fill("5.00");
  await page.getByRole("button", { name: /^Pay Rs 5.00/ }).click();
  await expect(page.getByTestId("done-offline")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Sale complete" }).locator(".eyebrow")).toHaveText("REGISTER1-OFF-000001");
  await page.getByRole("button", { name: "New sale" }).click();
  await expect(page.getByTestId("offline-waiting")).toHaveText("1 sale waiting to be sent");

  // Even a reload now does not lose the waiting sale: it lives on the device.
  await page.reload();
  await expect(page.getByTestId("offline-waiting")).toHaveText("1 sale waiting to be sent");

  await context.setOffline(false);
  await expect(page.getByTestId("offline-sent")).toContainText("Sent 1 sale", { timeout: 60_000 });
  const client = sql();
  try {
    const rows = await client<{ number: string; offline_ref: string }[]>`SELECT number, offline_ref FROM sales_invoices WHERE business_id = ${business.businessId}`;
    expect(rows).toEqual([{ number: "INV-KHI-000001", offline_ref: "REGISTER1-OFF-000001" }]);
  } finally {
    await client.end();
  }
});
