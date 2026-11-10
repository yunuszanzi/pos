import { expect, test } from "@playwright/test";
import { callApi, createTestBusiness, inviteTestStaff } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.2 acceptance tests (technical-plan 6) against the real UI, API and local Supabase. No mocks.

const header = "sku,name,category,tax_category,sale_price,cost,barcode";
function productRows(overrides: Record<number, string> = {}) {
  return Array.from({ length: 500 }, (_, index) => overrides[index]
    ?? `SKU-${index},Product ${index},Party > Balloons,Standard rate 18%,${10 + index}.50,${5 + index},89640${String(index).padStart(8, "0")}`);
}
const asFile = (name: string, rows: string[]) => ({ name, mimeType: "text/csv", buffer: Buffer.from([header, ...rows].join("\r\n")) });

test("1. import 500 products with a preview of errors; fix and re-import", async ({ page }) => {
  const business = await createTestBusiness();
  await signInThroughUi(page, business.ownerEmail);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Products" }).click();
  await page.getByRole("link", { name: "Import CSV" }).click();
  await page.getByRole("heading", { name: "Import products" }).waitFor();

  const broken = asFile("products.csv", productRows({
    9: "SKU-9,Product 9,Party > Balloons,Standard rate 18%,abc,5,8964000000009",
    99: "SKU-99,Product 99,Party > Balloons,Luxury tax,109.50,104,8964000000099",
    249: "SKU-0,Product 249,Party > Balloons,Standard rate 18%,259.50,254,8964000000249",
  }));
  await page.getByLabel("CSV file").setInputFiles(broken);
  await expect(page.getByText("3 problems found")).toBeVisible();
  const problemRow = (row: number) => page.getByRole("row").filter({ has: page.getByRole("cell", { name: String(row), exact: true }) });
  await expect(problemRow(11)).toContainText("sale_price");
  await expect(problemRow(101)).toContainText("Unknown tax category");
  await expect(problemRow(251)).toContainText('SKU "SKU-0" already appears on row 2');
  await expect(page.getByRole("button", { name: /^Import/ })).toBeDisabled();

  await page.getByLabel("CSV file").setInputFiles(asFile("products-fixed.csv", productRows()));
  await expect(page.getByText("The file is valid.")).toBeVisible();
  await expect(page.getByText("New categories: Party, Party > Balloons")).toBeVisible();
  await page.getByRole("button", { name: "Import 500 products" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Imported 500 products" })).toBeVisible();

  await page.getByRole("link", { name: "Back to products" }).click();
  await expect(page.getByText("Page 1 of 20 · 500 products")).toBeVisible();
  await page.getByLabel("Search").fill("Product 42");
  await expect(page.getByRole("cell", { name: "SKU-42", exact: true })).toBeVisible();
  const lookup = await callApi(business.ownerToken, "GET", "/products/lookup?barcode=8964000000042");
  expect(lookup.status).toBe(200);
});

test("2. a product sold in pieces and cartons converts correctly and can be found by either barcode", async ({ page }) => {
  const business = await createTestBusiness();
  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Products" }).click();
  await page.getByRole("link", { name: "New product" }).click();

  await page.getByLabel("Product name").fill("Latex Balloon 12 inch");
  await page.getByLabel("Tax category").selectOption({ label: "Standard rate 18%" });
  await page.getByLabel("SKU", { exact: true }).fill("BAL-12-RED");
  await page.getByLabel("Variant name").fill("Red");
  // Amounts are always shown with 2 decimals once you leave the box.
  await page.getByLabel("Sale price per base unit (PKR)").fill("5");
  await page.getByLabel("Sale price per base unit (PKR)").blur();
  await expect(page.getByLabel("Sale price per base unit (PKR)")).toHaveValue("5.00");
  await page.getByLabel("Cost per base unit (PKR)").fill("3.2");
  await page.getByLabel("Cost per base unit (PKR)").blur();
  await expect(page.getByLabel("Cost per base unit (PKR)")).toHaveValue("3.20");
  await page.getByLabel(/^Barcode \(base unit\)/).fill("8964000000017");
  await page.getByRole("button", { name: "Add unit" }).click();
  await page.locator('select[name="variants.0.otherUnits.0.unitId"]').selectOption({ label: "Carton" });
  await page.getByLabel("Pieces in one of this unit").fill("1000");
  await page.getByLabel("Barcode (this unit)").fill("8964000000024");
  await page.getByLabel("Sale price per this unit (PKR)").fill("4500");
  await expect(page.getByText("1 Carton = 1000 Piece")).toBeVisible();
  await page.getByRole("button", { name: "Save product" }).click();

  await expect(page.getByRole("row").filter({ hasText: "BAL-12-RED" })).toContainText("Rs 5.00");
  const carton = await callApi(business.ownerToken, "GET", "/products/lookup?barcode=8964000000024");
  expect(carton.body.factorToBase).toBe("1000");
  const piece = await callApi(business.ownerToken, "GET", "/products/lookup?barcode=8964000000017");
  expect(piece.body.factorToBase).toBe("1");

  // Editing keeps what the form does not show, and a duplicate SKU is reported in plain language.
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByLabel("Product name")).toHaveValue("Latex Balloon 12 inch");
  await expect(page.getByLabel("Cost per base unit (PKR)")).toHaveValue("3.20");
  await page.getByRole("button", { name: "Add SKU (variant)" }).click();
  await page.getByRole("region", { name: "SKU 2" }).getByLabel("SKU", { exact: true }).fill("BAL-12-RED");
  await page.getByRole("region", { name: "SKU 2" }).getByLabel("Sale price per base unit (PKR)").fill("5");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("alert")).toContainText("SKU");
  await page.getByRole("region", { name: "SKU 2" }).getByLabel("SKU", { exact: true }).fill("BAL-12-BLU");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("row").filter({ hasText: "BAL-12-BLU, BAL-12-RED" })).toBeVisible();
});

test("a generated internal barcode is a valid EAN-13", async ({ page }) => {
  const business = await createTestBusiness();
  await signInThroughUi(page, business.ownerEmail);
  await page.goto("/products/new");
  await page.getByRole("button", { name: "Generate" }).click();
  const code = await page.getByLabel(/^Barcode \(base unit\)/).inputValue();
  expect(code).toMatch(/^20\d{11}$/);
});

test("3. a cashier can browse products but cannot create, import, export or archive", async ({ page }) => {
  const business = await createTestBusiness();
  await callApi(business.ownerToken, "POST", "/categories", { body: { name: "Toys" } });
  const units = await callApi<Array<{ id: string; name: string }>>(business.ownerToken, "GET", "/units");
  await callApi(business.ownerToken, "POST", "/products", {
    body: { name: "Kite", baseUnitId: units.body.find((unit) => unit.name === "Piece")!.id, variants: [{ sku: "KITE-1", costPaisa: 900, units: [{ unitId: units.body.find((unit) => unit.name === "Piece")!.id, factorToBase: "1", salePricePaisa: 2500 }] }] },
  });
  const cashier = await inviteTestStaff(business, "Cashier");
  await signInThroughUi(page, cashier.email);

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Products" }).click();
  await expect(page.getByRole("row").filter({ hasText: "KITE-1" })).toContainText("Rs 25.00");
  for (const name of ["New product", "Import CSV", "Export CSV", "Edit", "Archive"]) {
    await expect(page.getByRole("link", { name }).or(page.getByRole("button", { name }))).toHaveCount(0);
  }
  for (const path of ["/products/new", "/products/import"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  }
  const response = await page.request.get("/api/v1/products/export", { headers: { Authorization: `Bearer ${cashier.token}` } });
  expect(response.status()).toBe(403);
});

test("the owner edits a tax rate, and a brand and category can be added", async ({ page }) => {
  const business = await createTestBusiness();
  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Categories & tax" }).click();

  await page.getByLabel("Reduced rate rate").fill("7.5");
  await page.getByRole("row").filter({ hasText: "Reduced rate" }).getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText("Reduced rate saved");
  await page.reload();
  await expect(page.getByLabel("Reduced rate rate")).toHaveValue("7.5");

  await page.getByLabel("New brand name").fill("Party Co");
  await page.getByRole("button", { name: "Add brand" }).click();
  await expect(page.getByRole("status")).toContainText("Brand added");
  await page.getByLabel("New category name").fill("Balloons");
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByRole("status")).toContainText("Category added");
  await page.getByLabel("New brand name").fill("party co");
  await page.getByRole("button", { name: "Add brand" }).click();
  await expect(page.getByRole("alert")).toContainText("already exists");
});
