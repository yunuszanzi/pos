import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, inviteTestStaff } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

test("the owner builds a wholesale price list with a quantity break, and it survives a reload", async ({ page }) => {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "PL-1", 100);
  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Price lists" }).click();
  await page.getByRole("button", { name: "New price list" }).click();

  const editor = page.getByRole("region", { name: "Price list editor" });
  await editor.getByLabel("Name").fill("Wholesale");
  for (const [minimum, price] of [["1", "850"], ["10", "800"]]) {
    await editor.getByLabel("Add a product").fill("PL-1");
    await editor.getByRole("button", { name: "Add PL-1" }).click();
    const rows = editor.getByRole("row").filter({ hasText: "PL-1" });
    const row = rows.last();
    await row.getByLabel("Unit for PL-1").selectOption({ label: "Carton" });
    await row.getByLabel("From quantity for PL-1").fill(minimum);
    await row.getByLabel("Price for PL-1").fill(price);
  }

  // The same product, unit and starting quantity twice is refused.
  await editor.getByRole("row").filter({ hasText: "PL-1" }).last().getByLabel("From quantity for PL-1").fill("1");
  await editor.getByRole("button", { name: "Save price list" }).click();
  await expect(editor.getByRole("alert")).toContainText("Duplicate price for the same product, unit and minimum quantity");
  await editor.getByRole("row").filter({ hasText: "PL-1" }).last().getByLabel("From quantity for PL-1").fill("10");
  await editor.getByRole("button", { name: "Save price list" }).click();
  await expect(page.getByText("Wholesale saved.")).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Open Wholesale" }).click();
  const reloaded = page.getByRole("region", { name: "Price list editor" });
  await expect(reloaded.getByLabel("Price for PL-1")).toHaveCount(2);
  await expect(reloaded.getByLabel("Price for PL-1").first()).toHaveValue("850.00");
  await expect(reloaded.getByLabel("From quantity for PL-1").last()).toHaveValue("10");
  await expect(reloaded.getByLabel("Price for PL-1").last()).toHaveValue("800.00");

  const saved = await callApi(business.ownerToken, "GET", "/price-lists");
  const list = await callApi(business.ownerToken, "GET", `/price-lists/${saved.body[0].id}`);
  expect(list.body.items.map((item: { minQuantity: string; pricePaisa: number; unitId: string }) => [item.minQuantity, item.pricePaisa, item.unitId === product.cartonId])).toEqual([["1", 85000, true], ["10", 80000, true]]);

  // Editing a price and removing a row are saved too.
  await reloaded.getByLabel("Price for PL-1").last().fill("790");
  await reloaded.getByRole("row").filter({ hasText: "PL-1" }).first().getByRole("button", { name: "Remove" }).click();
  await reloaded.getByRole("button", { name: "Save price list" }).click();
  await expect(page.getByText("Wholesale saved.")).toBeVisible();
  const after = await callApi(business.ownerToken, "GET", `/price-lists/${saved.body[0].id}`);
  expect(after.body.items.map((item: { minQuantity: string; pricePaisa: number }) => [item.minQuantity, item.pricePaisa])).toEqual([["10", 79000]]);
});

test("a cashier can read price lists but not change them", async ({ page }) => {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "PL-2", 100);
  await callApi(business.ownerToken, "POST", "/price-lists", {
    body: { name: "Dealer", items: [{ variantId: product.variantId, unitId: product.cartonId, minQuantity: "1", pricePaisa: 70000 }] },
  });
  const cashier = await inviteTestStaff(business, "Cashier");
  await signInThroughUi(page, cashier.email);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Price lists" }).click();
  await expect(page.getByRole("button", { name: "New price list" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open Dealer" }).click();
  const editor = page.getByRole("region", { name: "Price list editor" });
  await expect(editor.getByLabel("Price for PL-2")).toHaveValue("700.00");
  await expect(editor.getByLabel("Price for PL-2")).not.toBeEditable();
  await expect(editor.getByRole("button", { name: "Save price list" })).toHaveCount(0);
  await expect(editor.getByLabel("Add a product")).toHaveCount(0);
  const response = await page.request.put(`/api/v1/price-lists/${(await callApi(business.ownerToken, "GET", "/price-lists")).body[0].id}`, {
    headers: { Authorization: `Bearer ${cashier.token}` }, data: { name: "Hijacked", items: [] },
  });
  expect(response.status()).toBe(403);
});
