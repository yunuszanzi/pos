import { expect, test, type Page } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, inviteTestStaff } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.4 slice 2 against the real UI, API and local Supabase: credit sales, the manager's PIN, and receiving a payment.

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

test("2. credit sale at the till goes on the khata; over the limit it waits for a manager's PIN; a payment clears it", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "Q-1", 100);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nQ-1,1000,Piece,1.00" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  const customer = await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Ali Traders", phone: "0300-5551234", creditLimitPaisa: 10_000 } });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  const manager = await inviteTestStaff(business, "Manager");
  await openTill(page, business.ownerEmail);

  // Rs 150.00 bill, Rs 50.00 paid in cash, Rs 100.00 on credit: exactly the limit.
  await page.keyboard.press("F8");
  await page.getByLabel("Find a customer").fill("5551234");
  await page.getByRole("button", { name: /Ali Traders/ }).click();
  await scan(page, "30*Q-1-PC");
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 150.00");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByLabel("Amount 1").fill("50.00");
  await expect(page.getByTestId("pay-on-account")).toContainText("Rs 100.00 goes on Ali Traders's account");
  await page.getByRole("button", { name: /^Sell on account/ }).click();
  await expect(page.getByTestId("done-on-account")).toHaveText("Rs 100.00");
  await page.getByRole("button", { name: "New sale" }).click();

  // The till already knows the new balance: the customer bar shows it without another call.
  await page.keyboard.press("F8");
  await page.getByLabel("Find a customer").fill("5551234");
  await page.getByRole("button", { name: /Ali Traders/ }).click();
  await expect(page.getByTestId("cart-customer-account")).toHaveText("Owes Rs 100.00 · limit Rs 100.00");

  // One more item on credit passes the limit. The sale is refused, with the reason, until a manager approves.
  await scan(page, "Q-1-PC");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByRole("button", { name: "Put it all on account" }).click();
  await page.getByRole("button", { name: /^Sell on account/ }).click();
  await expect(page.getByText("Putting Rs 5.00 more on credit passes their limit of Rs 100.00. A manager must approve.")).toBeVisible();
  await page.getByLabel("Manager email").fill(manager.email);
  await page.getByLabel("Manager PIN").fill(manager.pin);
  await page.getByRole("button", { name: /^Sell on account/ }).click();
  await expect(page.getByTestId("done-on-account")).toHaveText("Rs 5.00");
  await page.getByRole("button", { name: "New sale" }).click();

  // The customer comes back and pays Rs 60.00: the oldest invoice (Rs 100.00) is settled by that much first.
  await page.getByRole("button", { name: "Customer payment" }).click();
  await page.getByLabel("Find a customer").fill("Ali");
  await page.getByRole("button", { name: /Ali Traders/ }).click();
  await expect(page.getByTestId("payment-owed")).toHaveText("Rs 105.00");
  await page.getByLabel("Amount received (Rs)").fill("60.00");
  await page.getByRole("button", { name: /^Receive Rs 60.00/ }).click();
  await expect(page.getByTestId("payment-received")).toHaveText("Rs 60.00");
  await expect(page.getByTestId("payment-balance")).toHaveText("Rs 45.00");
  await page.getByRole("button", { name: "Done" }).click();

  const khata = await callApi(business.ownerToken, "GET", `/customers/${customer.body.id}/ledger`);
  expect(khata.body.customer.balancePaisa).toBe(4_500);
  expect(khata.body.openInvoices.map((row: { outstandingPaisa: number }) => row.outstandingPaisa)).toEqual([4_000, 500]);
});

test("the back-office khata page shows the ledger and takes a payment", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "Q-1", 100);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nQ-1,100,Piece,1.00" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  const customer = await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Bilal Store", creditLimitPaisa: 100_000 } });
  const as = { terminalId: business.terminalId };
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: `s-${crypto.randomUUID()}` });
  const products = await callApi(business.ownerToken, "GET", "/products");
  const variant = products.body.data[0].variants[0];
  const unit = variant.units.find((row: { isBase: boolean }) => row.isBase);
  const sale = await callApi(business.ownerToken, "POST", "/sales", {
    ...as, idempotencyKey: `sale-${crypto.randomUUID()}`,
    body: { shiftId: shift.body.id, customerId: customer.body.id, lines: [{ variantId: variant.id, unitId: unit.unitId, quantity: "20" }], payments: [] },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);

  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Customers" }).click();
  await page.getByRole("row").filter({ hasText: "Bilal Store" }).getByRole("link", { name: "Khata" }).click();
  await expect(page.getByTestId("khata-balance")).toHaveText("Rs 100.00");
  await expect(page.getByRole("table", { name: "Open invoices" })).toContainText(sale.body.invoice.number);
  await expect(page.getByRole("table", { name: "Ledger" }).getByRole("row").filter({ hasText: "Invoice" })).toContainText("Rs 100.00");

  // Back office has no drawer, so it takes money by wallet or bank.
  await page.getByRole("button", { name: "Receive payment" }).click();
  await page.getByLabel("Method").selectOption({ label: "JazzCash" });
  await page.getByLabel("Reference").fill("JC-5");
  await page.getByLabel("Amount received (Rs)").fill("100.00");
  await page.getByRole("button", { name: /^Receive Rs 100.00/ }).click();
  await expect(page.getByTestId("payment-balance")).toHaveText("Rs 0.00");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("khata-balance")).toHaveText("Rs 0.00");
  await expect(page.getByText("Nothing is owing on any invoice.")).toBeVisible();
});
