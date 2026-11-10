import { expect, test } from "@playwright/test";
import { callApi, createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.7 slice 1 against the real UI, API and local Supabase: an account, an expense with its bill, a reversal, and an expense from the register.

const key = () => `key-${crypto.randomUUID()}`;
// A 1x1 PNG.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("5. an account is opened, an expense is paid from it with a photo of the bill, reversed, and another is paid from the register", async ({ page }) => {
  const business = await createTestBusiness();
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { terminalId: business.terminalId, body: { openingFloatPaisa: 100_000 }, idempotencyKey: key() });
  expect(shift.status, JSON.stringify(shift.body)).toBe(201);

  await signInThroughUi(page, business.ownerEmail);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Accounts", exact: true }).click();
  // Wallets and bank methods already have accounts; add the bank account the shop really uses.
  await expect(page.getByRole("table", { name: "Accounts" })).toContainText("JazzCash");
  const add = page.getByRole("region", { name: "Add an account" });
  await add.getByLabel("Name").fill("HBL Current");
  await add.getByLabel("It holds today (Rs)").fill("1000.00");
  await add.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByRole("table", { name: "Accounts" })).toContainText("HBL Current");
  await expect(page.getByTestId("accounts-total")).toHaveText("Rs 1,000.00");

  // Rent of Rs 300.00 from the bank, with the bill.
  await nav.getByRole("link", { name: "Expenses", exact: true }).click();
  await page.getByRole("link", { name: "Record an expense" }).click();
  await expect(page.getByRole("heading", { name: "Record an expense" })).toBeVisible();
  await page.getByLabel("Category").selectOption({ label: "Rent" });
  await page.getByLabel("Amount (Rs)").fill("300.5");
  await page.getByLabel("Amount (Rs)").blur();
  await expect(page.getByLabel("Amount (Rs)")).toHaveValue("300.50"); // always two decimals
  await page.getByLabel("Paid from").selectOption({ label: "HBL Current" });
  await page.getByLabel("Paid to").fill("Landlord");
  await page.getByLabel("Photo or PDF of the bill").setInputFiles({ name: "rent.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "Record expense" }).click();

  await expect(page.getByRole("heading", { name: /EXP-.*/ })).toBeVisible();
  await expect(page.getByTestId("expense-amount")).toHaveText("Rs 300.50");
  await page.getByRole("button", { name: "Show the bill" }).click();
  const bill = page.getByRole("link", { name: /Open the bill \(rent\.png\)/ });
  await expect(bill).toBeVisible();
  const response = await page.request.get((await bill.getAttribute("href"))!);
  expect(response.status()).toBe(200);

  // The account went down; reversing the expense puts it back and keeps the record.
  await page.goto("/accounts");
  await expect(page.getByTestId("accounts-total")).toHaveText("Rs 699.50");
  await page.goto("/expenses");
  await page.getByRole("link", { name: /EXP-/ }).first().click();
  await page.getByRole("button", { name: "Reverse this expense" }).click();
  await page.getByLabel("Why is it being reversed?").fill("Entered twice");
  await page.getByRole("button", { name: "Reverse expense" }).click();
  await expect(page.getByRole("heading", { name: /— Reversed/ })).toBeVisible();
  await page.goto("/accounts");
  await expect(page.getByTestId("accounts-total")).toHaveText("Rs 1,000.00");

  // Tea money from the register: the open shift's expected cash drops.
  await page.goto("/expenses/new");
  await page.getByLabel("Category").selectOption({ label: "Tea and refreshments" });
  await page.getByLabel("Amount (Rs)").fill("25");
  await page.getByLabel("Paid from").selectOption({ label: "The register (open shift)" });
  await page.getByRole("button", { name: "Record expense" }).click();
  await expect(page.getByRole("heading", { name: /EXP-/ })).toBeVisible();
  await expect(page.getByText("The register (cash drawer)")).toBeVisible();
  const report = await callApi(business.ownerToken, "GET", `/shifts/${shift.body.id}/report`, { terminalId: business.terminalId });
  expect(report.body.report).toMatchObject({ cashOutPaisa: 2_500, expectedCashPaisa: 97_500 });

  // The list: both expenses; the reversed one does not count towards the total.
  await page.goto("/expenses");
  await expect(page.getByRole("table", { name: "Expenses" }).getByRole("row")).toHaveCount(4); // header, two expenses, footer
  await expect(page.getByTestId("expenses-total")).toHaveText("Rs 25.00");
});
