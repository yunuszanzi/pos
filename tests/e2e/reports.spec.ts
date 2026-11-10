import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, inviteStaffWithPermissions, sql } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.7 slice 2 against the real UI, API and local Supabase: a report is run, narrowed, exported, and profit stays hidden from a sales-only user.

const key = () => `key-${crypto.randomUUID()}`;

test("6. a report is run and narrowed, exported to a spreadsheet, and a sales-only user never sees cost or profit", async ({ page, browser }) => {
  const business = await createTestBusiness();
  const a = await createSimpleProduct(business, "A", 100);
  const b = await createSimpleProduct(business, "B", 100);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,100,Piece,1.00\nB,100,Piece,1.00" }, idempotencyKey: key() });
  const as = { terminalId: business.terminalId };
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
  const client = sql();
  const [{ id: cash }] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${business.businessId} AND code = 'cash'`;
  await client.end();
  for (const [product, quantity] of [[a, "10"], [b, "4"]] as const) {
    const sale = await callApi(business.ownerToken, "POST", "/sales", {
      ...as, idempotencyKey: key(),
      body: { shiftId: shift.body.id, lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity }], payments: [{ methodId: cash, amountPaisa: Number(quantity) * 500 }] },
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  }

  await signInThroughUi(page, business.ownerEmail);
  // The home page shows today at a glance: the same figures the reports give.
  await expect(page.getByTestId("dash-sales")).toHaveText("Rs 70.00");
  await expect(page.getByTestId("dash-profit")).toHaveText("Rs 56.00"); // 70.00 less 14.00 of cost
  await expect(page.getByRole("table", { name: "Best sellers today" })).toContainText("Product A");
  await expect(page.getByRole("img", { name: /Sales for the last 14 days/ })).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page.getByRole("region", { name: "Sales" })).toContainText("Sales by product");
  await expect(page.getByRole("region", { name: "Profit" })).toContainText("Profit and loss");
  await expect(page.getByRole("region", { name: "Tax" })).toContainText("Sales tax summary");
  await page.getByRole("link", { name: "Sales by product" }).click();

  // Both products, biggest first, with the totals under the table; money always with two decimals.
  const table = page.getByRole("table", { name: "Sales by product" });
  await expect(table.getByRole("row")).toHaveCount(4); // header, two products, totals
  await expect(table.getByRole("row").nth(1)).toContainText("Product A");
  await expect(table.getByRole("row").nth(1)).toContainText("Rs 50.00");
  await expect(page.getByTestId("total-sales")).toHaveText("Rs 70.00");
  // The owner sees cost and profit.
  await expect(table.getByRole("columnheader", { name: "Profit before expenses" })).toBeVisible();
  await expect(table.getByRole("row").nth(1)).toContainText("Rs 40.00"); // 50.00 less 10 x Re 1.00

  // Dates with nothing in them.
  await page.getByRole("textbox", { name: "From", exact: true }).fill("2020-01-01");
  await page.getByRole("textbox", { name: "To", exact: true }).fill("2020-01-31");
  await expect(page.getByText("Nothing to show for these choices.")).toBeVisible();
  await page.getByRole("button", { name: "This month" }).click();
  await expect(table.getByRole("row")).toHaveCount(4);

  // Export to a spreadsheet.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export to a spreadsheet (CSV)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^sales-by-product-\d{4}-\d{2}-01-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await file.path())!, "utf8");
  expect(csv).toContain("Product,Quantity (base units),Sales (with tax),Tax,Cost of goods,Profit before expenses");
  expect(csv).toContain("Product A,10,50.00,0.00,10.00,40.00");
  expect(csv).toContain("Total,,70.00,0.00,14.00,56.00");

  // A person who may see sales but not profit: no cost or profit anywhere, and the profit reports are not even listed.
  const staff = await inviteStaffWithPermissions(business, "Sales viewer", ["reports.sales.view"]);
  const context = await browser.newContext();
  const staffPage = await context.newPage();
  await staffPage.goto("/login");
  await signInThroughUi(staffPage, staff.email);
  await expect(staffPage.getByTestId("dash-sales")).toHaveText("Rs 70.00");
  await expect(staffPage.getByTestId("dash-profit")).toHaveCount(0);
  await expect(staffPage.getByTestId("dash-cash")).toHaveCount(0);
  await staffPage.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Reports", exact: true }).click();
  await expect(staffPage.getByRole("region", { name: "Sales" })).toBeVisible();
  await expect(staffPage.getByRole("region", { name: "Profit" })).toHaveCount(0);
  await expect(staffPage.getByRole("region", { name: "Tax" })).toHaveCount(0);
  await staffPage.getByRole("link", { name: "Sales by product" }).click();
  const staffTable = staffPage.getByRole("table", { name: "Sales by product" });
  await expect(staffTable.getByRole("row")).toHaveCount(4);
  await expect(staffTable.getByRole("columnheader", { name: /Cost|Profit/ })).toHaveCount(0);
  await staffPage.goto("/reports/profit-and-loss");
  await expect(staffPage.getByText("Report not available")).toBeVisible();
  await context.close();
});
