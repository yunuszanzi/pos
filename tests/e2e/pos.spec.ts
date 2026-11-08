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
  await page.waitForLoadState("networkidle"); // and the stock levels
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

// ---- printing (FR-PRT) ----

type Captured = { text: string; css: string };
async function capturePrints(page: Page) {
  await page.addInitScript(() => {
    const prints: Array<{ text: string; css: string }> = [];
    (window as unknown as { __prints: typeof prints }).__prints = prints;
    window.print = () => {
      const root = document.querySelector(".receipt-print-root");
      prints.push({ text: root?.textContent ?? "", css: root?.querySelector("style")?.textContent ?? "" });
    };
  });
  return () => page.evaluate(() => (window as unknown as { __prints: Array<{ text: string; css: string }> }).__prints as Captured[]);
}

test("2. prints an 80 mm slip, then reprints the same sale as A4 marked DUPLICATE and logged", async ({ page }) => {
  const prints = await capturePrints(page);
  const business = await stockedBusiness(["A", "B"]);
  await openTill(page, business);
  await scan(page, "2*A-PC");
  await scan(page, "B-PC");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByLabel("Amount 1").fill("20.00");
  await page.getByRole("button", { name: /^Pay Rs 15.00/ }).click();
  await expect(page.getByRole("dialog", { name: "Sale complete" })).toBeVisible();

  // The shop auto-prints by default: one original slip.
  await expect.poll(async () => (await prints()).length).toBe(1);
  const [slip] = await prints();
  expect(slip.css).toContain("80mm auto");
  expect(slip.text).toContain("SALES RECEIPT");
  expect(slip.text).toContain("INV-KHI-000001");
  expect(slip.text).toContain("Rs 15.00");
  expect(slip.text).toContain("Change");
  expect(slip.text).toContain("Rs 5.00");
  expect(slip.text).not.toContain("DUPLICATE");

  await page.getByRole("dialog", { name: "Sale complete" }).getByLabel("Print format").selectOption("a4");
  await page.getByRole("button", { name: "Print duplicate" }).click();
  await expect.poll(async () => (await prints()).length).toBe(2);
  const copy = (await prints())[1];
  expect(copy.css).toContain("size: A4");
  expect(copy.text).toContain("SALES INVOICE");
  expect(copy.text).toContain("DUPLICATE — copy 1, not the original");
  expect(copy.text).toContain("INV-KHI-000001");
  expect(copy.text).toContain("Rs 15.00");

  const audit = await callApi(business.ownerToken, "GET", "/audit-log?pageSize=100");
  const reprints = audit.body.data.filter((row: { action: string; entity: string }) => row.entity === "sales_invoice" && row.action === "reprint");
  expect(reprints).toHaveLength(1);
  expect(reprints[0].after).toMatchObject({ format: "a4", number: "INV-KHI-000001" });

  // Finding the sale again later: another copy, numbered 2.
  await page.getByRole("button", { name: "New sale" }).click();
  await page.getByRole("button", { name: "Recent sales" }).click();
  await page.getByLabel("Find a sale by number").fill("000001");
  await page.getByRole("button", { name: "Reprint" }).click();
  await expect.poll(async () => (await prints()).length).toBe(3);
  expect((await prints())[2].text).toContain("DUPLICATE — copy 2");
});

test("the slip width follows the chosen format, and auto-print off waits for the button", async ({ page }) => {
  const prints = await capturePrints(page);
  const business = await stockedBusiness(["A"]);
  const settings = await callApi(business.ownerToken, "GET", "/settings");
  await callApi(business.ownerToken, "PUT", "/settings", { body: { ...settings.body, autoPrintReceipt: false } });
  await openTill(page, business);
  await scan(page, "A-PC");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByRole("button", { name: /^Pay Rs 5.00/ }).click();
  await expect(page.getByRole("dialog", { name: "Sale complete" })).toBeVisible();
  expect(await prints()).toHaveLength(0);
  await page.getByRole("dialog", { name: "Sale complete" }).getByLabel("Print format").selectOption("pos58");
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await expect.poll(async () => (await prints()).length).toBe(1);
  const [slip] = await prints();
  expect(slip.css).toContain("58mm auto");
  expect(slip.text).not.toContain("DUPLICATE");
});

test("the till shows what is in stock, warns when a row asks for more, and the daily report adds up", async ({ page }) => {
  const business = await stockedBusiness(["A", "B"]); // 100 of each
  await openTill(page, business);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: /Product A/ })).toContainText("100 in stock");

  await scan(page, "150*A-PC");
  await expect(page.getByRole("row", { name: /Product A/ })).toContainText("only 100 in stock");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByRole("button", { name: /^Pay Rs 750.00/ }).click();
  await expect(page.getByRole("alert")).toContainText("Not enough stock of Product A (A): 100 on hand, 150 needed");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /^Clear/ }).click();
  await scan(page, "4*A-PC");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByRole("button", { name: /^Pay Rs 20.00/ }).click();
  await page.getByRole("button", { name: "New sale" }).click();
  await expect(page.getByRole("button", { name: /Product A/ })).toContainText("96 in stock");

  await page.goto("/reports/daily-sales");
  await expect(page.getByTestId("report-total")).toHaveText("Rs 20.00");
  await expect(page.getByTestId("report-profit")).toHaveText("Rs 16.00"); // 4 x (5.00 - 1.00)
  await expect(page.getByRole("table", { name: "Best sellers" })).toContainText("Product A");
  await expect(page.getByRole("table", { name: "Payments by method" })).toContainText("Cash");
});
