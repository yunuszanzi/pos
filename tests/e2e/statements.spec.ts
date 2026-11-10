import { businessToday } from "../../shared/dates";
import { expect, test } from "@playwright/test";
import { callApi, createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.4 slice 4 against the real UI, API and local Supabase: loading opening balances, the ageing report and a customer's statement.

const daysAgo = (days: number) => new Date(Date.parse(businessToday()) - days * 86_400_000).toISOString().slice(0, 10);
const csv = (text: string) => ({ name: "balances.csv", mimeType: "text/csv", buffer: Buffer.from(text) });

test("4. opening balances are loaded from a file, aged, and shown on a statement that can be sent on WhatsApp", async ({ page }) => {
  const business = await createTestBusiness();
  for (const customer of [{ name: "Ali Traders", phone: "0300-5551234" }, { name: "Bilal Stores", phone: "0321-7778888" }]) {
    const created = await callApi(business.ownerToken, "POST", "/customers", { body: { ...customer, creditLimitPaisa: 10_000_000 } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  }
  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Customers", exact: true }).click();
  await page.getByRole("link", { name: "Opening balances" }).click();

  // A bad file is explained row by row and cannot be loaded.
  await page.locator('input[type="file"]').setInputFiles(csv("customer,balance,date\nNobody At All,10.00,\nAli Traders,12.345,\n"));
  await expect(page.getByText("2 problems found")).toBeVisible();
  await expect(page.getByText(/No active customer called "Nobody At All"/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Load opening balances" })).toBeDisabled();

  // A good file: one customer owes, one is owed.
  await page.locator('input[type="file"]').setInputFiles(csv(`customer,phone,balance,date,note\nAli Traders,,450.00,${daysAgo(100)},Old register\n,0321-7778888,-25.50,${daysAgo(3)},Advance\n`));
  await expect(page.getByText("The file is valid.")).toBeVisible();
  await page.getByRole("button", { name: "Load opening balances" }).click();
  await expect(page.getByText(/Opening balances loaded for 2 customers: Rs 450.00 owed to you, Rs 25.50 credit/)).toBeVisible();

  // The debt is 100 days old, so it sits in the oldest band and is overdue (no payment terms: 30 days). Credit is not debt.
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Customer ageing" }).click();
  const ageing = page.getByRole("table", { name: "Ageing" });
  await expect(ageing.getByRole("row")).toHaveCount(3); // header, Ali, total
  const ali = ageing.getByRole("row", { name: /Ali Traders/ });
  await expect(ali.getByRole("cell").nth(4)).toHaveText("Rs 450.00");
  await expect(ali).toContainText("Overdue");
  await expect(page.getByTestId("ageing-total")).toHaveText("Rs 450.00");
  await expect(ageing).not.toContainText("Bilal Stores");
  const remind = page.getByRole("link", { name: "Remind Ali Traders on WhatsApp" });
  await expect(remind).toHaveAttribute("href", /^https:\/\/wa\.me\/923005551234\?text=.*Rs%20450\.00/);

  // The statement for this month opens with the balance, and the khata offers the same reminder.
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Customers", exact: true }).click();
  await page.getByRole("row", { name: /Ali Traders/ }).getByRole("link", { name: "Statement" }).click();
  await expect(page.getByTestId("statement-opening")).toHaveText("Rs 450.00");
  await expect(page.getByTestId("statement-closing")).toHaveText("Rs 450.00");
  await expect(page.getByText("Nothing happened on this account in this period.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Send on WhatsApp" })).toHaveAttribute("href", /wa\.me\/923005551234/);

  // Widening the period to include the opening balance moves it from "opening" into the entries.
  await page.getByLabel("From").fill(daysAgo(120));
  await expect(page.getByTestId("statement-opening")).toHaveText("Rs 0.00");
  await expect(page.getByRole("table", { name: "Statement" })).toContainText("Old register");
  await expect(page.getByTestId("statement-closing")).toHaveText("Rs 450.00");
});
