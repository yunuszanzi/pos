import { expect, test, type Page } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, inviteTestStaff } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.4 slice 3 against the real UI, API and local Supabase: taking goods back at the till and finding the credit notes afterwards.

async function openTill(page: Page, email: string) {
  await signInThroughUi(page, email);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Point of sale" }).click();
  await page.getByLabel("Opening cash (Rs)").fill("0.00");
  await page.getByRole("button", { name: "Open shift" }).click();
  await expect(page.getByLabel("Scan or search")).toBeVisible();
  await expect(page.getByRole("button", { name: /Product / }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test("3. goods come back against a bill, then with no bill under a manager's PIN, and both credit notes are listed", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "Q-1", 100);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nQ-1,1000,Piece,1.00" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  const customer = await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Ali Traders", phone: "0300-5551234", creditLimitPaisa: 100_000 } });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  const manager = await inviteTestStaff(business, "Manager");
  await openTill(page, business.ownerEmail);

  // Ten pieces at Rs 5.00: Rs 20.00 paid, Rs 30.00 on Ali's khata.
  await page.keyboard.press("F8");
  await page.getByLabel("Find a customer").fill("5551234");
  await page.getByRole("button", { name: /Ali Traders/ }).click();
  await page.getByLabel("Scan or search").fill("10*Q-1-PC");
  await page.getByLabel("Scan or search").press("Enter");
  await expect(page.getByTestId("cart-total")).toHaveText("Rs 50.00");
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.getByLabel("Amount 1").fill("20.00");
  await page.getByRole("button", { name: /^Sell on account/ }).click();
  await expect(page.getByTestId("done-on-account")).toHaveText("Rs 30.00");
  await page.getByRole("button", { name: "New sale" }).click();

  // Four come back. Ali still owes Rs 30.00 on that bill, so Rs 20.00 of the return pays that off and nothing is handed over.
  const sales = await callApi(business.ownerToken, "GET", "/sales");
  const number = sales.body.data[0].number as string;
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await page.getByLabel("Find the bill").fill(number);
  await page.getByRole("button", { name: "Return from this bill" }).click();
  // A quantity box takes digits and one decimal point only, whether typed key by key or pasted.
  const quantityBox = page.getByLabel("Quantity of Product Q-1 to return");
  await quantityBox.pressSequentially("a1b-2.c3.4567e");
  await expect(quantityBox).toHaveValue("12.345");
  await quantityBox.fill("x4 pieces");
  await expect(quantityBox).toHaveValue("4");
  await expect(page.getByTestId("return-total")).toHaveText("Rs 20.00");
  await expect(page.getByTestId("return-pay-off")).toContainText("Rs 20.00 of this pays off what Ali Traders owes on the bill");
  await page.getByRole("button", { name: /^Take back Rs 20.00/ }).click();
  await expect(page.getByTestId("return-done-total")).toHaveText("Rs 20.00");
  await expect(page.getByTestId("return-done-account")).toHaveText("Rs 20.00");
  await expect(page.getByTestId("return-done-balance")).toHaveText("Rs 10.00");
  await page.getByRole("button", { name: "Done" }).click();

  // The till already knows Ali's new balance, without asking again.
  await page.keyboard.press("F8");
  await page.getByLabel("Find a customer").fill("5551234");
  await page.getByRole("button", { name: /Ali Traders/ }).click();
  await expect(page.getByTestId("cart-customer-account")).toHaveText("Owes Rs 10.00 · limit Rs 1,000.00");
  await page.keyboard.press("Escape");

  // No bill: today's price, a manager's PIN, and cash back from the drawer.
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await page.getByRole("button", { name: "The customer has no bill" }).click();
  await page.getByLabel("Find the item").fill("Q-1");
  await page.getByRole("button", { name: /Piece · Rs 5.00/ }).click();
  await page.getByLabel("Quantity of Product Q-1 to return").fill("2");
  await expect(page.getByTestId("return-total")).toHaveText("Rs 10.00");
  await page.getByRole("button", { name: /^Take back Rs 10.00/ }).click();
  await expect(page.getByText("Returned without a receipt. A manager must approve it.")).toBeVisible();
  await page.getByLabel("Manager email").fill(manager.email);
  await page.getByLabel("Manager PIN").fill(manager.pin);
  await page.getByRole("button", { name: /^Take back Rs 10.00/ }).click();
  await expect(page.getByTestId("return-done-refund")).toHaveText("Rs 10.00");
  await page.getByRole("button", { name: "Done" }).click();

  const khata = await callApi(business.ownerToken, "GET", `/customers/${customer.body.id}/ledger`);
  expect(khata.body.customer.balancePaisa).toBe(1_000);
  const returnable = await callApi(business.ownerToken, "GET", `/sales/${sales.body.data[0].id}/returnable`);
  expect(returnable.body.lines[0]).toMatchObject({ returnedQuantity: "4", remainingQuantity: "6" });

  // Back office: both credit notes are listed.
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Returns", exact: true }).click();
  const table = page.getByRole("table", { name: "Returns" });
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table).toContainText(number);
  await expect(table).toContainText("no bill");
});
