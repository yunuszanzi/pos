import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.4 slice 5 against the real UI, API and local Supabase: taking a cheque, depositing it, and a bounce.

const tomorrow = () => new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA");

test("5. a post-dated cheque is taken, deposited and cleared; another bounces and the khata goes back up", async ({ page }) => {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "C-1", 100);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nC-1,1000,Piece,1.00" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  const customer = await callApi(business.ownerToken, "POST", "/customers", { body: { name: "Cheque Customer", phone: "0300-1112222", creditLimitPaisa: 10_000_000 } });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { terminalId: business.terminalId, body: { openingFloatPaisa: 0 }, idempotencyKey: `shift-${crypto.randomUUID()}` });
  const sale = await callApi(business.ownerToken, "POST", "/sales", {
    terminalId: business.terminalId, idempotencyKey: `sale-${crypto.randomUUID()}`,
    body: { shiftId: shift.body.id, customerId: customer.body.id, lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity: "100" }], payments: [] },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201); // Rs 500.00 on credit

  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Cheques", exact: true }).click();

  async function receive(chequeNo: string, amount: string) {
    await page.getByRole("button", { name: "Receive a cheque" }).click();
    await page.getByLabel("Find a customer").fill("Cheque");
    await page.getByRole("button", { name: /Cheque Customer/ }).click();
    await page.getByLabel("Cheque number").fill(chequeNo);
    await page.getByLabel("Bank").fill("HBL");
    await page.getByLabel("Amount (Rs)").fill(amount);
    await page.getByLabel("Date on the cheque").fill(tomorrow());
    await page.getByRole("button", { name: /^Receive Rs/ }).click();
    await expect(page.getByTestId("cheque-recorded-amount")).toHaveText(`Rs ${amount}`);
    await page.getByRole("button", { name: "Done" }).click();
  }

  await receive("100001", "200.00");
  await receive("100002", "150.00");
  const table = page.getByRole("table", { name: "Cheques" });
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("row", { name: /100001/ })).toContainText("In hand");
  await expect(table.getByRole("row", { name: /100001/ })).not.toContainText("Due"); // dated tomorrow
  const owed = async () => (await callApi(business.ownerToken, "GET", `/customers/${customer.body.id}/ledger`)).body.customer.balancePaisa as number;
  expect(await owed()).toBe(15_000); // Rs 500.00 - 200.00 - 150.00

  // First cheque: deposited, then cleared. It leaves the "In hand" list.
  await table.getByRole("row", { name: /100001/ }).getByRole("button", { name: "Deposited" }).click();
  await expect(page.getByText("Cheque 100001 deposited.")).toBeVisible();
  await page.getByLabel("Show").selectOption("deposited");
  await table.getByRole("row", { name: /100001/ }).getByRole("button", { name: "Cleared" }).click();
  await expect(page.getByText("Cheque 100001 cleared.")).toBeVisible();
  await page.getByLabel("Show").selectOption("cleared");
  await expect(table.getByRole("row", { name: /100001/ })).toContainText("Cleared");
  expect(await owed()).toBe(15_000);

  // Second cheque: bounces. The reason is required, and the khata goes back up by the cheque.
  await page.getByLabel("Show").selectOption("received");
  await table.getByRole("row", { name: /100002/ }).getByRole("button", { name: "Bounced" }).click();
  await expect(page.getByRole("button", { name: "Mark as bounced" })).toBeDisabled();
  await page.getByLabel("Why did it bounce?").fill("Insufficient funds");
  await page.getByRole("button", { name: "Mark as bounced" }).click();
  await expect(page.getByText(/Cheque 100002 bounced. Rs 150.00 is back on Cheque Customer's khata./)).toBeVisible();
  expect(await owed()).toBe(30_000);
  await page.getByLabel("Show").selectOption("bounced");
  await expect(table.getByRole("row", { name: /100002/ })).toContainText("Insufficient funds");
});
