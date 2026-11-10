import { expect, test, type Page } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, sql, type TestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.9 acceptance test 2 (technical-plan 6) against the real UI, API and local Supabase, with the built-in mock standing in for FBR:
// unplug the network, make 10 sales, reconnect: all 10 sync in order, none duplicated, FBR submits them.

async function fbrBusiness() {
  const business = await createTestBusiness();
  const tax = await callApi(business.ownerToken, "POST", "/tax-categories", { body: { name: "GST 18%", kind: "standard", rateBps: 1800 } });
  await createSimpleProduct(business, "OFF-A", 100, { taxCategoryId: tax.body.id, hsCode: "9503.0090" });
  await callApi(business.ownerToken, "PUT", `/fbr/tax-categories/${tax.body.id}`, { body: { fbrSaleType: "Goods at standard rate (default)" } });
  const client = sql();
  await client`UPDATE product_units SET fbr_uom = 'Numbers, pieces, units' WHERE business_id = ${business.businessId}`;
  await client.end();
  expect((await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nOFF-A,100,Piece,1.00" }, idempotencyKey: `open-${crypto.randomUUID()}` })).status).toBe(201);
  expect((await callApi(business.ownerToken, "PUT", "/fbr/token", { body: { token: "mock-ok-token" } })).status).toBe(200);
  const on = await callApi(business.ownerToken, "PUT", "/fbr/config", {
    body: { enabled: true, mode: "di", environment: "sandbox", sellerName: "Example Traders (Pvt) Ltd", sellerNtn: "1234567-8", sellerStrn: "17-00-1234-567-89", sellerProvince: "SINDH", sellerAddress: "Shop 4, Saddar, Karachi", cancelWindowHours: 72, buyerIdThresholdPaisa: 5_000_000, confirmUntested: false },
  });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  return business;
}

async function capturePrints(page: Page) {
  await page.addInitScript(() => {
    const prints: Array<{ text: string }> = [];
    (window as unknown as { __prints: typeof prints }).__prints = prints;
    window.print = () => { prints.push({ text: document.querySelector(".receipt-print-root")?.textContent ?? "" }); };
  });
  return () => page.evaluate(() => (window as unknown as { __prints: Array<{ text: string }> }).__prints);
}

async function openTill(page: Page, business: TestBusiness) {
  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Point of sale" }).click();
  await page.getByLabel("Opening cash (Rs)").fill("0.00");
  await page.getByRole("button", { name: "Open shift" }).click();
  await expect(page.getByLabel("Scan or search")).toBeVisible();
  await expect(page.getByRole("button", { name: /Product / }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
}

async function sellOne(page: Page) {
  const box = page.getByLabel("Scan or search");
  await box.fill("OFF-A-PC");
  await box.press("Enter");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByLabel("Amount 1").fill("5.00");
  await page.getByRole("button", { name: /^Pay Rs 5.00/ }).click();
  await expect(page.getByRole("dialog", { name: "Sale complete" })).toBeVisible();
}

test("2. with the network unplugged, 10 sales are taken; on reconnecting all 10 sync in order, none twice, and FBR is sent them", async ({ page, context }) => {
  const prints = await capturePrints(page);
  const business = await fbrBusiness();
  await openTill(page, business);

  await context.setOffline(true);
  await expect(page.getByTestId("till-offline")).toBeVisible();
  for (let n = 1; n <= 10; n += 1) {
    await sellOne(page);
    await expect(page.getByTestId("done-offline")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Sale complete" }).locator(".eyebrow")).toHaveText(`REGISTER1-OFF-${String(n).padStart(6, "0")}`);
    await page.getByRole("button", { name: "New sale" }).click();
  }
  await expect(page.getByTestId("offline-waiting")).toHaveText("10 sales waiting to be sent");

  // Each slip said so: offline, to be synced, with its own reference.
  const slips = await prints();
  expect(slips).toHaveLength(10);
  expect(slips[0].text).toContain("OFFLINE SALE, TO BE SYNCED");
  expect(slips[0].text).toContain("REGISTER1-OFF-000001");
  expect(slips[9].text).toContain("REGISTER1-OFF-000010");
  // Nothing has reached the books yet.
  const client = sql();
  try {
    const [{ count }] = await client<{ count: string }[]>`SELECT count(*)::text AS count FROM sales_invoices WHERE business_id = ${business.businessId}`;
    expect(Number(count)).toBe(0);

    // The network comes back: the till sends them by itself.
    await context.setOffline(false);
    await expect(page.getByTestId("offline-sent")).toContainText("Sent 10 sales", { timeout: 60_000 });
    await expect(page.getByTestId("till-offline")).toHaveCount(0);

    const invoices = await client<Array<{ number: string; offline_ref: string; fbr_status: string; fbr_irn: string | null; total_paisa: string }>>`
      SELECT number, offline_ref, fbr_status, fbr_irn, total_paisa::text FROM sales_invoices WHERE business_id = ${business.businessId} ORDER BY sequence_no`;
    // All ten, once each, numbered in the order they were made.
    expect(invoices).toHaveLength(10);
    expect(invoices.map((row) => row.number)).toEqual(Array.from({ length: 10 }, (_, index) => `INV-KHI-${String(index + 1).padStart(6, "0")}`));
    expect(invoices.map((row) => row.offline_ref)).toEqual(Array.from({ length: 10 }, (_, index) => `REGISTER1-OFF-${String(index + 1).padStart(6, "0")}`));
    // FBR was sent every one, and accepted them.
    expect(invoices.every((row) => row.fbr_status === "accepted" && row.fbr_irn)).toBe(true);
    const [{ submissions }] = await client<{ submissions: string }[]>`SELECT count(*)::text AS submissions FROM fbr_submissions WHERE business_id = ${business.businessId}`;
    expect(Number(submissions)).toBe(10);
    // Stock came down by ten and nothing went below zero, so nothing is waiting for review.
    const stock = await callApi(business.ownerToken, "GET", "/stock?pageSize=10");
    expect(stock.body.data[0].onHand).toBe("90");
    expect((await callApi(business.ownerToken, "GET", "/offline-sales/summary")).body).toEqual({ open: 0 });
  } finally {
    await client.end();
  }

  // Selling carries on normally afterwards, with an ordinary number.
  await sellOne(page);
  await expect(page.getByTestId("done-offline")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Sale complete" }).locator(".eyebrow")).toHaveText("INV-KHI-000011");
});
