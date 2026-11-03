import { expect, test, type Page } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// Barcode label printing (FR-PRD-10) in a real browser, including the pages Chromium would send to a printer.

async function printedPageCount(page: Page): Promise<number> {
  await page.emulateMedia({ media: "print" });
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: "screen" });
  return (pdf.toString("latin1").match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length;
}

async function openLabelsFor(page: Page, sku: string) {
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Products" }).click();
  await page.getByRole("link", { name: "Print labels" }).click();
  await page.getByLabel("Find a product to add").fill(sku);
  await page.getByRole("button", { name: `Add ${sku}` }).click();
}

test("labels are previewed at real size, laid out on the chosen stock, and sent to the printer", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "LBL-1", 100);
  await signInThroughUi(page, business.ownerEmail);
  await openLabelsFor(page, "LBL-1");

  const preview = page.getByRole("region", { name: "Preview" });
  await page.getByRole("group", { name: "Label LBL-1" }).getByLabel("Copies").fill("3");
  await expect(preview.getByTestId("label")).toHaveCount(3);
  const first = preview.getByTestId("label").first();
  await expect(first).toContainText("Product LBL-1");
  await expect(first).toContainText("Rs 5.00");
  await expect(first.getByRole("img", { name: "Barcode LBL-1-PC" })).toHaveAttribute("src", /^data:image\/svg\+xml/);
  await expect(page.getByRole("button", { name: "Print 3 labels" })).toBeEnabled();

  // Three labels fit on one A4 sheet; on a roll each label is its own page.
  await expect(preview.getByTestId("label-page")).toHaveCount(1);
  expect(await printedPageCount(page)).toBe(1);

  // A sheet that is already mostly used: starting at position 23 pushes the third label onto a second sheet.
  await page.getByLabel(/^Start at position/).fill("23");
  await expect(preview.getByTestId("label-page")).toHaveCount(2);
  expect(await printedPageCount(page)).toBe(2);
  await page.getByLabel(/^Start at position/).fill("25");
  await expect(page.getByRole("alert")).toContainText("between 1 and 24");
  await page.getByLabel(/^Start at position/).fill("1");

  await page.getByLabel("Label format").selectOption({ label: "Label roll · 50 × 30 mm, one per label" });
  await expect(preview.getByTestId("label-page")).toHaveCount(3);
  expect(await printedPageCount(page)).toBe(3);

  // What the printer sees is the label sheet only, not the app around it.
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#root")).toBeHidden();
  await expect(page.locator(".label-print-root .label-cell").first()).toBeVisible();
  await page.emulateMedia({ media: "screen" });

  await page.evaluate(() => { (window as unknown as { printCalls: number }).printCalls = 0; window.print = () => { (window as unknown as { printCalls: number }).printCalls += 1; }; });
  await page.getByRole("button", { name: "Print 3 labels" }).click();
  expect(await page.evaluate(() => (window as unknown as { printCalls: number }).printCalls)).toBe(1);
});

test("a label for the carton prints the carton's barcode and price", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "LBL-2", 100);
  await signInThroughUi(page, business.ownerEmail);
  await openLabelsFor(page, "LBL-2");
  await page.getByRole("group", { name: "Label LBL-2" }).locator("select").selectOption({ label: "Carton" });
  const label = page.getByRole("region", { name: "Preview" }).getByTestId("label");
  await expect(label).toHaveCount(1);
  await expect(label).toContainText("Rs 900.00");
  await expect(label.getByRole("img", { name: "Barcode LBL-2-CTN" })).toBeVisible();
  await page.getByLabel("Show price").uncheck();
  await page.getByLabel("Show SKU").uncheck();
  await expect(label).not.toContainText("Rs 900.00");
});

test("a unit without a barcode is flagged and not printed", async ({ page }) => {
  const business = await createTestBusiness();
  const units = await callApi<Array<{ id: string; name: string }>>(business.ownerToken, "GET", "/units");
  const piece = units.body.find((unit) => unit.name === "Piece")!.id;
  await callApi(business.ownerToken, "POST", "/products", {
    body: { name: "Plain Item", baseUnitId: piece, variants: [{ sku: "NOBAR-1", units: [{ unitId: piece, factorToBase: "1", salePricePaisa: 100 }] }] },
  });
  await signInThroughUi(page, business.ownerEmail);
  await openLabelsFor(page, "NOBAR-1");
  await expect(page.getByRole("alert")).toContainText("NOBAR-1 has no barcode on the chosen unit and will not be printed");
  await expect(page.getByRole("button", { name: /^Print 0 labels/ })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Preview" }).getByTestId("label")).toHaveCount(0);
});
