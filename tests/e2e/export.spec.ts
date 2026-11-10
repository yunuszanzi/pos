import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// FR-AUD-03 through the screens: the owner downloads everything, and one table as CSV.

test("the owner downloads all the business's data, and a table as CSV", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "EXP-1", 100);
  await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Bilal Wholesale", phone: "0301-1111111" } });
  await signInThroughUi(page, business.ownerEmail);
  await page.goto("/settings");
  const everything = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download everything (JSON)" }).click();
  const file = await everything;
  expect(file.suggestedFilename()).toMatch(/^business-data.*\.json$/);
  const data = JSON.parse(readFileSync((await file.path())!, "utf8"));
  expect(data.businessId).toBe(business.businessId);
  expect(data.tables.customers[0].name).toBe("Bilal Wholesale");

  await page.getByText("One table at a time").click();
  const one = page.waitForEvent("download");
  await page.getByRole("listitem").filter({ hasText: "customers" }).getByRole("button", { name: "Download" }).click();
  const csv = await one;
  expect(csv.suggestedFilename()).toMatch(/^customers-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(readFileSync((await csv.path())!, "utf8")).toContain("Bilal Wholesale");
});
