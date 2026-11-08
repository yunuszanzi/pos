import { expect, test } from "@playwright/test";
import { createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.5 slice 1 against the real UI, API and local Supabase: adding suppliers, loading what is owed to them, and the payables ageing.

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const csv = (text: string) => ({ name: "payables.csv", mimeType: "text/csv", buffer: Buffer.from(text) });

test("1. suppliers are added, opening payables are loaded and aged, and the ledger shows what is owed", async ({ page }) => {
  const business = await createTestBusiness();
  await signInThroughUi(page, business.ownerEmail);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Suppliers", exact: true }).click();

  async function addSupplier(name: string, phone: string) {
    await page.getByRole("link", { name: "New supplier" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Phone", { exact: true }).fill(phone);
    // The payment terms box takes digits only.
    await page.getByLabel("Payment terms (days)").fill("3a0");
    await expect(page.getByLabel("Payment terms (days)")).toHaveValue("30");
    await page.getByRole("button", { name: "Save supplier" }).click();
    await expect(page.getByRole("table", { name: "Suppliers" })).toContainText(name);
  }
  await addSupplier("Karachi Balloon Mills", "0300-1112222");
  await addSupplier("Lahore Packaging", "0321-3334444");

  // A second supplier with the same name is refused with a plain message.
  await page.getByRole("link", { name: "New supplier" }).click();
  await page.getByLabel("Name", { exact: true }).fill("karachi balloon mills");
  await page.getByRole("button", { name: "Save supplier" }).click();
  await expect(page.getByText("A supplier with this name already exists")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // Opening payables: a bad file is explained; a good one loads.
  await page.getByRole("link", { name: "Opening payables" }).click();
  await page.locator('input[type="file"]').setInputFiles(csv("supplier,balance\nNobody,10.00\n"));
  await expect(page.getByText("1 problem found")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load opening payables" })).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles(csv(`supplier,phone,balance,date,note\nKarachi Balloon Mills,,2500.00,${daysAgo(100)},Old bills\n,0321-3334444,-100.00,${daysAgo(2)},Advance\n`));
  await expect(page.getByText("The file is valid.")).toBeVisible();
  await page.getByRole("button", { name: "Load opening payables" }).click();
  await expect(page.getByText(/Opening payables loaded for 2 suppliers: Rs 2,500.00 owed, Rs 100.00 credit/)).toBeVisible();

  // Ageing: the old debt is overdue; the supplier we hold credit with is not listed.
  await nav.getByRole("link", { name: "Payables ageing" }).click();
  const ageing = page.getByRole("table", { name: "Payables ageing" });
  await expect(ageing.getByRole("row", { name: /Karachi Balloon Mills/ })).toContainText("Overdue");
  await expect(ageing).not.toContainText("Lahore Packaging");
  await expect(page.getByTestId("payables-total")).toHaveText("Rs 2,500.00");

  // The list shows who we owe and who owes us; the ledger has the entry.
  await nav.getByRole("link", { name: "Suppliers", exact: true }).click();
  await expect(page.getByRole("row", { name: /Lahore Packaging/ })).toContainText("Rs 100.00 credit");
  await page.getByRole("row", { name: /Karachi Balloon Mills/ }).getByRole("link", { name: "Ledger" }).click();
  await expect(page.getByTestId("supplier-balance")).toHaveText("Rs 2,500.00");
  await expect(page.getByRole("table", { name: "Ledger" })).toContainText("Old bills");
});
