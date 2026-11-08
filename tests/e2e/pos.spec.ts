import { expect, test, type Page } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, sql, type TestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.3 acceptance tests (technical-plan 6) against the real UI, API and local Supabase. No mocks.

async function stockedBusiness(skus: string[]) {
  const business = await createTestBusiness();
  for (const sku of skus) await createSimpleProduct(business, sku, 100);
  const csv = ["sku,quantity,unit,cost", ...skus.map((sku) => `${sku},100,Piece,1.00`)].join("\n");
  const stocked = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv }, idempotencyKey: `open-${crypto.randomUUID()}` });
  expect(stocked.status).toBe(201);
  return business;
}

async function openTill(page: Page, business: TestBusiness, float = "0.00") {
  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Point of sale" }).click();
  await page.getByLabel("Opening cash (Rs)").fill(float);
  await page.getByRole("button", { name: "Open shift" }).click();
  await expect(page.getByLabel("Scan or search")).toBeVisible();
  await expect(page.getByRole("button", { name: /Product / }).first()).toBeVisible(); // the catalogue has arrived
}

async function scan(page: Page, code: string) {
  const box = page.getByLabel("Scan or search");
  await box.fill(code);
  await box.press("Enter");
}

const invoiceCount = async (business: TestBusiness) => {
  const client = sql();
  try {
    const [{ count }] = await client<{ count: string }[]>`SELECT count(*) FROM sales_invoices WHERE business_id = ${business.businessId}`;
    return Number(count);
  } finally {
    await client.end();
  }
};

test("1. scan 5 items, 5% bill discount, split cash + JazzCash: totals and change are correct", async ({ page }) => {
  const business = await stockedBusiness(["A", "B", "C", "D", "E"]);
  await openTill(page, business);
  for (const sku of ["A", "B", "C", "D", "E"]) await scan(page, `${sku}-PC`);
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 25.00");

  await page.getByRole("button", { name: /Bill discount/ }).click();
  await page.getByLabel("Discount", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 23.75");

  await page.getByRole("button", { name: /^Pay/ }).click();
  await expect(page.getByTestId("pay-total")).toHaveText("Rs 23.75");
  await page.getByLabel("Amount 1").fill("10.00");
  await expect(page.getByTestId("pay-remaining")).toHaveText("Rs 13.75");
  await page.getByRole("button", { name: "+ Add another payment" }).click();
  await page.getByLabel("Payment method 2").selectOption({ label: "JazzCash" });
  await expect(page.getByLabel("Amount 2")).toHaveValue("13.75");
  await page.getByLabel("Reference 2").fill("JC-1001");
  await expect(page.getByTestId("pay-remaining")).toHaveText("Rs 0.00");
  await page.getByRole("button", { name: /^Pay Rs 23.75/ }).click();

  await expect(page.getByRole("dialog", { name: "Sale complete" })).toBeVisible();
  await expect(page.getByTestId("done-total")).toHaveText("Rs 23.75");
  await expect(page.getByTestId("done-change")).toHaveText("Rs 0.00");
  expect(await invoiceCount(business)).toBe(1);
});

test("cash over the total gives change", async ({ page }) => {
  const business = await stockedBusiness(["A"]);
  await openTill(page, business);
  await scan(page, "3*A-PC");
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 15.00");
  await page.keyboard.press("F4");
  await page.getByLabel("Amount 1").fill("20.00");
  await expect(page.getByTestId("pay-change")).toHaveText("Rs 5.00");
  await page.getByRole("button", { name: /^Pay Rs 15.00/ }).click();
  await expect(page.getByTestId("done-change")).toHaveText("Rs 5.00");
});

test("5. double-clicking Pay creates one invoice", async ({ page }) => {
  const business = await stockedBusiness(["A"]);
  await openTill(page, business);
  await scan(page, "A-PC");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByRole("button", { name: /^Pay Rs 5.00/ }).dblclick();
  await expect(page.getByRole("dialog", { name: "Sale complete" })).toBeVisible();
  expect(await invoiceCount(business)).toBe(1);
});

test("selling 50 scanned items makes no API call until Pay, and Pay makes one", async ({ page }) => {
  const business = await stockedBusiness(["A"]);
  await openTill(page, business);
  const calls: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) calls.push(`${request.method()} ${new URL(request.url()).pathname}`); });

  for (let i = 0; i < 50; i += 1) await scan(page, "A-PC");
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 250.00");
  await page.getByLabel("Scan or search").fill("zzz-not-a-product");
  await page.getByLabel("Scan or search").press("Enter");
  await expect(page.getByText('Nothing found for "zzz-not-a-product"')).toBeVisible();
  expect(calls).toEqual([]);

  await page.keyboard.press("F4");
  await page.getByRole("button", { name: /^Pay Rs 250.00/ }).click();
  await expect(page.getByRole("dialog", { name: "Sale complete" })).toBeVisible();
  expect(calls).toEqual(["POST /api/v1/sales"]);
});

test("4. close the shift with a cash count: the Z report shows expected, counted and variance", async ({ page }) => {
  const business = await stockedBusiness(["A"]);
  await openTill(page, business, "100.00");
  await scan(page, "5*A-PC");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByRole("button", { name: /^Pay Rs 25.00/ }).click();
  await page.getByRole("button", { name: "New sale" }).click();

  await page.getByRole("button", { name: "Close shift" }).click();
  await page.getByLabel("Cash counted in the drawer (Rs)").fill("120.00");
  await page.getByRole("button", { name: "Close shift" }).last().click();
  const report = page.getByRole("dialog", { name: /Z report/ });
  await expect(report).toContainText("Expected cash");
  await expect(report).toContainText("Rs 125.00");
  await expect(report).toContainText("Rs 120.00");
  await expect(report.getByTestId("variance")).toHaveText("Rs -5.00");
  await report.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: "Open a shift" })).toBeVisible();
});

test("a held sale can be recalled", async ({ page }) => {
  const business = await stockedBusiness(["A", "B"]);
  await openTill(page, business);
  await scan(page, "A-PC");
  await scan(page, "B-PC");
  await page.getByRole("button", { name: /^Hold/ }).click();
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 0.00");
  await page.getByRole("button", { name: /^Held/ }).click();
  await page.getByRole("button", { name: "Recall" }).click();
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 10.00");
});
