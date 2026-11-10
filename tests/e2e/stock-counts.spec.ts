import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.9 stock counts against the real UI, API and local Supabase: start, scan and type counts, review the variance, approve.

test("a count is scanned and typed, handed in, reviewed and approved; only then does stock change", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "CNT-A", 100);
  await createSimpleProduct(business, "CNT-B", 200);
  const stocked = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nCNT-A,10,Piece,1.00\nCNT-B,20,Piece,2.00" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  expect(stocked.status).toBe(201);

  await signInThroughUi(page, business.ownerEmail);
  await page.goto("/stock-counts");
  await page.getByRole("button", { name: "Start counting" }).click();
  await expect(page.getByTestId("count-status")).toHaveText("Being counted");
  await expect(page.getByTestId("count-progress")).toHaveText("0 of 2 items");

  // Scan CNT-A eight times (3 + 5): 8 against the 10 the books say.
  const scan = page.getByLabel("Scan or type a barcode");
  await scan.fill("3*CNT-A-PC");
  await scan.press("Enter");
  await expect(page.getByText("Product CNT-A (CNT-A): 3 counted")).toBeVisible();
  await scan.fill("5*CNT-A-PC");
  await scan.press("Enter");
  await expect(page.getByTestId("variance-CNT-A")).toHaveText("-2");
  // Type CNT-B: 25 against 20.
  const typed = page.getByLabel("Counted CNT-B");
  await typed.fill("25");
  await typed.press("Enter");
  await expect(page.getByTestId("variance-CNT-B")).toHaveText("+5");
  await expect(page.getByTestId("count-progress")).toHaveText("2 of 2 items");
  await expect(page.getByTestId("count-differences")).toContainText("2 items · 5 over · 2 short");
  await expect(page.getByTestId("count-value")).toContainText("Rs 8.00");

  // Nothing has changed stock yet.
  const before = await callApi(business.ownerToken, "GET", "/stock?pageSize=100");
  expect(before.body.data.map((row: { sku: string; onHand: string }) => `${row.sku}=${row.onHand}`).sort()).toEqual(["CNT-A=10", "CNT-B=20"]);

  await page.getByRole("button", { name: /hand in for review/ }).click();
  await expect(page.getByTestId("count-status")).toHaveText("Waiting for review");
  await page.getByRole("button", { name: "Approve and correct the stock" }).click();
  await expect(page.getByTestId("count-status")).toHaveText("Approved");

  const after = await callApi(business.ownerToken, "GET", "/stock?pageSize=100");
  expect(after.body.data.map((row: { sku: string; onHand: string }) => `${row.sku}=${row.onHand}`).sort()).toEqual(["CNT-A=8", "CNT-B=25"]);
});
