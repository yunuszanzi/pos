import { expect, test, type Page } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, inviteTestStaff, type TestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.4 slice 1 against the real UI, API and local Supabase. No mocks.

async function openTill(page: Page, email: string) {
  await signInThroughUi(page, email);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Point of sale" }).click();
  await page.getByLabel("Opening cash (Rs)").fill("0.00");
  await page.getByRole("button", { name: "Open shift" }).click();
  await expect(page.getByLabel("Scan or search")).toBeVisible();
  await expect(page.getByRole("button", { name: /Product / }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
}

async function scan(page: Page, code: string) {
  await page.getByLabel("Scan or search").fill(code);
  await page.getByLabel("Scan or search").press("Enter");
}

/** A product at Rs 5.00 on the shelf, a wholesale list (Rs 4.50, Rs 4.00 from 100), a group on it and a customer in the group. */
async function wholesaleCustomer(business: TestBusiness) {
  const product = await createSimpleProduct(business, "W-1", 100);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nW-1,1000,Piece,1.00" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  const list = await callApi(business.ownerToken, "POST", "/price-lists", {
    body: { name: "Wholesale", items: [
      { variantId: product.variantId, unitId: product.pieceId, minQuantity: "1", pricePaisa: 450 },
      { variantId: product.variantId, unitId: product.pieceId, minQuantity: "100", pricePaisa: 400 },
    ] },
  });
  const group = await callApi(business.ownerToken, "POST", "/customer-groups", { body: { name: "Wholesalers", priceListId: list.body.id } });
  const customer = await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Ali Traders", phone: "0300-5551234", groupId: group.body.id } });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  return customer.body;
}

test("the owner adds a customer in the back office, finds them, edits and archives them", async ({ page }) => {
  const business = await createTestBusiness();
  await callApi(business.ownerToken, "POST", "/areas", { body: { name: "Saddar" } });
  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Customers" }).click();
  await page.getByRole("link", { name: "New customer" }).click();

  await page.getByLabel("Name", { exact: true }).fill("Bilal Store");
  await page.getByLabel("Phone", { exact: true }).fill("0321-5550000");
  await page.getByLabel("CNIC").fill("123");
  await page.getByRole("button", { name: "Save customer" }).click();
  await expect(page.getByText("CNIC has 13 digits")).toBeVisible();

  await page.getByLabel("CNIC").fill("42101-1234567-1");
  await page.getByLabel("Area").selectOption({ label: "Saddar" });
  await page.getByLabel("Credit limit (Rs)").fill("50000");
  await page.getByLabel("Payment terms (days)").fill("30");
  await page.getByRole("button", { name: "Save customer" }).click();

  const row = page.getByRole("row").filter({ hasText: "Bilal Store" });
  await expect(row).toContainText("Saddar");
  await expect(row).toContainText("Rs 50,000.00");
  await expect(row).toContainText("30 days");

  await page.getByLabel("Search customers").fill("5550000");
  await expect(page.getByRole("row").filter({ hasText: "Bilal Store" })).toBeVisible();
  await page.getByLabel("Search customers").fill("nobody");
  await expect(page.getByText("No customers found.")).toBeVisible();
  await page.getByLabel("Search customers").fill("");

  await page.getByRole("row").filter({ hasText: "Bilal Store" }).getByRole("link", { name: "Edit" }).click();
  await expect(page.getByLabel("CNIC")).toHaveValue("4210112345671");
  await page.getByLabel("Name", { exact: true }).fill("Bilal Stores");
  await page.getByRole("button", { name: "Save customer" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Bilal Stores" })).toBeVisible();

  await page.getByRole("row").filter({ hasText: "Bilal Stores" }).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("Bilal Stores was archived")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Bilal Stores" })).toHaveCount(0);
});

test("1. a wholesale customer gets their tier price automatically at the till, with the quantity break", async ({ page }) => {
  const business = await createTestBusiness();
  await wholesaleCustomer(business);
  await openTill(page, business.ownerEmail);

  await scan(page, "W-1-PC");
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 5.00"); // walk-in: shelf price
  await expect(page.getByTestId("cart-customer")).toHaveText("Walk-in");

  await page.keyboard.press("F8");
  await page.getByLabel("Find a customer").fill("5551234");
  await page.getByRole("button", { name: /Ali Traders/ }).click();
  await expect(page.getByTestId("cart-customer")).toHaveText("Ali Traders");
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 4.50");

  await scan(page, "99*W-1-PC"); // 100 pieces in the cart: the quantity break
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 400.00");

  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByRole("button", { name: /^Pay Rs 400.00/ }).click();
  await expect(page.getByTestId("done-total")).toHaveText("Rs 400.00");
});

test("a cashier adds a customer at the till with a name and phone, and sells to them", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "Q-1", 100);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nQ-1,10,Piece,1.00" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  const cashier = await inviteTestStaff(business, "Cashier");
  await openTill(page, cashier.email);

  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: "Add new customer" }).click();
  await page.getByLabel("Name").fill("Sara Khan");
  await page.getByLabel("Phone").fill("0333-7778888");
  await page.getByRole("button", { name: "Add and select" }).click();
  await expect(page.getByTestId("cart-customer")).toHaveText("Sara Khan");

  await scan(page, "Q-1-PC");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByRole("button", { name: /^Pay Rs 5.00/ }).click();
  await expect(page.getByRole("dialog", { name: "Sale complete" })).toBeVisible();

  const customers = await callApi(business.ownerToken, "GET", "/customers?q=Sara");
  expect(customers.body.data).toHaveLength(1);
  await page.getByRole("button", { name: "New sale" }).click();
  // The new customer is findable at once, from the local list, without a reload.
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByLabel("Find a customer").fill("7778888");
  await expect(page.getByRole("button", { name: /Sara Khan/ })).toBeVisible();
});
