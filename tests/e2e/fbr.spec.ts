import { expect, test, type Page } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, sql, type TestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.8 acceptance tests (technical-plan 6) against the real UI, API and local Supabase, with the built-in mock standing in for FBR
// (the token decides how it answers: mock-ok-token accepts, mock-down is unreachable).

async function fbrBusiness(token: string) {
  const business = await createTestBusiness();
  const tax = await callApi(business.ownerToken, "POST", "/tax-categories", { body: { name: "GST 18%", kind: "standard", rateBps: 1800 } });
  await createSimpleProduct(business, "A", 100, { taxCategoryId: tax.body.id, hsCode: "9503.0090" });
  await callApi(business.ownerToken, "PUT", `/fbr/tax-categories/${tax.body.id}`, { body: { fbrSaleType: "Goods at standard rate (default)" } });
  const client = sql();
  await client`UPDATE product_units SET fbr_uom = 'Numbers, pieces, units' WHERE business_id = ${business.businessId}`;
  await client.end();
  const stocked = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,100,Piece,1.00" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  expect(stocked.status).toBe(201);
  expect((await callApi(business.ownerToken, "PUT", "/fbr/token", { body: { token } })).status).toBe(200);
  const on = await callApi(business.ownerToken, "PUT", "/fbr/config", {
    body: { enabled: true, mode: "di", environment: "sandbox", sellerName: "Example Traders (Pvt) Ltd", sellerNtn: "1234567-8", sellerStrn: "17-00-1234-567-89", sellerProvince: "SINDH", sellerAddress: "Shop 4, Saddar, Karachi", cancelWindowHours: 72, buyerIdThresholdPaisa: 5_000_000, confirmUntested: false },
  });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  return business;
}

type Printed = { text: string; qr: number };
async function capturePrints(page: Page) {
  await page.addInitScript(() => {
    const prints: Array<{ text: string; qr: number }> = [];
    (window as unknown as { __prints: typeof prints }).__prints = prints;
    window.print = () => {
      const root = document.querySelector(".receipt-print-root");
      prints.push({ text: root?.textContent ?? "", qr: root?.querySelectorAll('img[alt="FBR invoice QR code"]').length ?? 0 });
    };
  });
  return () => page.evaluate(() => (window as unknown as { __prints: Printed[] }).__prints);
}

async function sellOneAtTheTill(page: Page, business: TestBusiness) {
  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Point of sale" }).click();
  await page.getByLabel("Opening cash (Rs)").fill("0.00");
  await page.getByRole("button", { name: "Open shift" }).click();
  await expect(page.getByLabel("Scan or search")).toBeVisible();
  await expect(page.getByRole("button", { name: /Product / }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const box = page.getByLabel("Scan or search");
  await box.fill("A-PC");
  await box.press("Enter");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByLabel("Amount 1").fill("5.00");
  await page.getByRole("button", { name: /^Pay Rs 5.00/ }).click();
  await expect(page.getByRole("dialog", { name: "Sale complete" })).toBeVisible();
}

const submissions = async (business: TestBusiness) => {
  const client = sql();
  try {
    return await client<Array<{ id: string; status: string; irn: string | null; attempts: number }>>`SELECT id, status, irn, attempts FROM fbr_submissions WHERE business_id = ${business.businessId}`;
  } finally {
    await client.end();
  }
};

test("1. with the sandbox, a sale is accepted and the slip and the A4 bill both print FBR's number and QR code", async ({ page }) => {
  const prints = await capturePrints(page);
  const business = await fbrBusiness("mock-ok-token");
  await sellOneAtTheTill(page, business);

  const notice = page.getByTestId("done-fbr");
  await expect(notice).toContainText("FBR invoice no.");
  const [row] = await submissions(business);
  expect(row.status).toBe("accepted");
  expect(row.irn).toBeTruthy();
  await expect(notice).toContainText(row.irn!);

  await expect.poll(async () => (await prints()).length).toBe(1);
  const [slip] = await prints();
  expect(slip.text).toContain(`FBR invoice no.: ${row.irn}`);
  expect(slip.qr).toBe(1);

  await page.getByRole("dialog", { name: "Sale complete" }).getByLabel("Print format").selectOption("a4");
  await page.getByRole("button", { name: "Print duplicate" }).click();
  await expect.poll(async () => (await prints()).length).toBe(2);
  const sheet = (await prints())[1];
  expect(sheet.text).toContain(`FBR invoice no.: ${row.irn}`);
  expect(sheet.qr).toBe(1);

  // The log shows it as accepted, with the number.
  await page.goto("/fbr/log");
  await expect(page.getByRole("table", { name: "FBR log" })).toContainText("Accepted");
  await expect(page.getByRole("table", { name: "FBR log" })).toContainText(row.irn!);
});

test("2. with FBR unreachable the sale still completes as pending, and is accepted automatically once FBR is back, with no duplicate", async ({ page, request }) => {
  const business = await fbrBusiness("mock-down");
  await sellOneAtTheTill(page, business);
  await expect(page.getByTestId("done-fbr")).toContainText("FBR could not be reached");
  let rows = await submissions(business);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("pending");
  expect(rows[0].irn).toBeNull();

  // FBR comes back; the next scheduled run is due.
  expect((await callApi(business.ownerToken, "PUT", "/fbr/token", { body: { token: "mock-ok-token" } })).status).toBe(200);
  const client = sql();
  await client`UPDATE fbr_submissions SET next_retry_at = now() - interval '1 minute' WHERE business_id = ${business.businessId}`;
  await client.end();
  const url = `${process.env.TEST_API_URL}/api/jobs/fbr-retry?businessId=${business.businessId}`;
  const headers = { Authorization: `Bearer ${process.env.CRON_SECRET}` };
  expect((await request.get(url, { headers })).status()).toBe(200);
  // Running it again changes nothing.
  await request.get(url, { headers });

  rows = await submissions(business);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("accepted");
  expect(rows[0].irn).toBeTruthy();

  await page.goto("/fbr/log");
  await expect(page.getByRole("table", { name: "FBR log" })).toContainText("Accepted");
});

test("the owner saves the token, tests the connection and passes a sandbox scenario", async ({ page }) => {
  const business = await createTestBusiness();
  await signInThroughUi(page, business.ownerEmail);
  await page.goto("/settings/fbr");
  await expect(page.getByTestId("fbr-mock-banner")).toBeVisible();
  await expect(page.getByTestId("fbr-token-state")).toContainText("No token saved yet");
  await page.getByLabel("FBR security token").fill("mock-ok-token");
  await page.getByRole("button", { name: "Save token" }).click();
  await expect(page.getByTestId("fbr-token-state")).toContainText("A token is saved");
  await expect(page.getByTestId("fbr-token-state")).not.toContainText("mock-ok-token");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByTestId("fbr-last-test")).toContainText("worked");
  // A scenario needs the seller's details, as a real invoice does.
  await page.getByLabel("Business name").fill("Example Traders (Pvt) Ltd");
  await page.getByLabel("NTN", { exact: true }).fill("1234567-8");
  await page.getByLabel("Province").fill("SINDH");
  await page.getByLabel("Address").fill("Shop 4, Saddar, Karachi");
  await page.getByRole("button", { name: "Save FBR settings" }).click();
  await expect(page.getByText("FBR settings saved")).toBeVisible();
  await page.getByRole("row", { name: /SN001/ }).getByRole("button", { name: "Run" }).click();
  await expect(page.getByTestId("scenario-SN001")).toContainText("Passed");
});
