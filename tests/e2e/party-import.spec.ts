import { expect, test } from "@playwright/test";
import { createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v1.0 go-live: customers and suppliers loaded from a CSV file, through the screens.

const csv = (name: string, ...lines: string[]) => ({ name, mimeType: "text/csv", buffer: Buffer.from(lines.join("\r\n")) });

test("the owner loads customers from a file: a bad row blocks the import, a fixed file loads and lists them", async ({ page }) => {
  const business = await createTestBusiness();
  await signInThroughUi(page, business.ownerEmail);
  await page.goto("/customers");
  await page.getByRole("link", { name: "Import customers" }).click();

  await page.getByLabel("CSV file").setInputFiles(csv("bad.csv", "name,phone,credit_limit", "Bilal Wholesale,0301-1111111,50000.00", ",0302-2222222,abc"));
  await expect(page.getByText("2 problems found")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load customers" })).toBeDisabled();

  await page.getByLabel("CSV file").setInputFiles(csv("good.csv", "name,phone,credit_limit", "Bilal Wholesale,0301-1111111,50000.00", "Sana Stores,0302-2222222,0"));
  await expect(page.getByText("The file is valid.")).toBeVisible();
  await page.getByRole("button", { name: "Load customers" }).click();
  await expect(page.getByTestId("party-import-done")).toHaveText("2 customers loaded.");

  await page.goto("/customers");
  await expect(page.getByRole("row").filter({ hasText: "Bilal Wholesale" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Sana Stores" })).toBeVisible();
});

test("the owner loads suppliers from a file", async ({ page }) => {
  const business = await createTestBusiness();
  await signInThroughUi(page, business.ownerEmail);
  await page.goto("/suppliers/import");
  await page.getByLabel("CSV file").setInputFiles(csv("suppliers.csv", "name,terms_days", "Karachi Balloon Mills,30", "Lahore Latex,15"));
  await page.getByRole("button", { name: "Load suppliers" }).click();
  await expect(page.getByTestId("party-import-done")).toHaveText("2 suppliers loaded.");
  await page.goto("/suppliers");
  await expect(page.getByRole("row").filter({ hasText: "Karachi Balloon Mills" })).toBeVisible();
});
