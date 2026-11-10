import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, sql } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.7 slice 3 against the real UI, API and local Supabase: a day is blocked while a shift is open, closed, and then takes no more expenses.

const key = () => `key-${crypto.randomUUID()}`;

test("7. the day cannot be closed with a shift open; closed, it takes no new expense; reopened, it does again", async ({ page }) => {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nA,100,Piece,1.00" }, idempotencyKey: key() });
  const as = { terminalId: business.terminalId };
  const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 100_000 }, idempotencyKey: key() });
  const client = sql();
  const [{ id: cash }] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${business.businessId} AND code = 'cash'`;
  await client.end();
  const sale = await callApi(business.ownerToken, "POST", "/sales", {
    ...as, idempotencyKey: key(),
    body: { shiftId: shift.body.id, lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity: "2" }], payments: [{ methodId: cash, amountPaisa: 1_000 }] },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  const bank = (await callApi(business.ownerToken, "POST", "/accounts", { body: { name: "HBL Current", kind: "bank", openingBalancePaisa: 100_000 } })).body;

  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Day-end closing", exact: true }).click();

  // The shift is still open: the day shows what it has so far but cannot be closed.
  await expect(page.getByTestId("day-sales")).toHaveText("Rs 10.00");
  await expect(page.getByText(/A shift is still open on Register 1/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Close the day" })).toBeDisabled();

  // The drawer is counted Re 0.50 over; now the day can be closed.
  const counted = await callApi(business.ownerToken, "POST", `/shifts/${shift.body.id}/close`, { ...as, body: { countedPaisa: 101_050 }, idempotencyKey: key() });
  expect(counted.status, JSON.stringify(counted.body)).toBe(200);
  await page.reload();
  await expect(page.getByTestId("cash-variance")).toHaveText("Rs 0.50");
  await page.getByRole("button", { name: "Close the day" }).click();
  await expect(page.getByText(/CLS-.*is closed for Main Branch/)).toBeVisible();
  await expect(page.getByText("This day is closed.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Past closings" }).getByRole("row")).toHaveCount(2);

  // A closed day takes no expense dated into it: the screen says why.
  const categories = (await callApi(business.ownerToken, "GET", "/expense-categories")).body.data as Array<{ id: string; name: string }>;
  await page.goto("/expenses/new");
  await expect(page.getByRole("heading", { name: "Record an expense" })).toBeVisible();
  await page.getByLabel("Category").selectOption({ label: categories[0].name });
  await page.getByLabel("Amount (Rs)").fill("3");
  await page.getByLabel("Paid from").selectOption({ label: bank.name });
  await page.getByRole("button", { name: "Record expense" }).click();
  await expect(page.getByText(/is closed for this branch/)).toBeVisible();

  // Reopen it, with a reason; the expense then goes in.
  await page.goto("/day-closings");
  await page.getByRole("table", { name: "Past closings" }).getByRole("link", { name: /CLS-/ }).click();
  await expect(page.getByTestId("day-sales")).toHaveText("Rs 10.00");
  await page.getByRole("button", { name: "Reopen this day" }).click();
  await page.getByLabel("Why is the day being reopened?").fill("Forgot the tea money");
  await page.getByRole("button", { name: "Reopen the day" }).click();
  await expect(page.getByRole("heading", { name: /— Reopened/ })).toBeVisible();
  await page.goto("/expenses/new");
  await expect(page.getByRole("heading", { name: "Record an expense" })).toBeVisible();
  await page.getByLabel("Category").selectOption({ label: categories[0].name });
  await page.getByLabel("Amount (Rs)").fill("3");
  await page.getByLabel("Paid from").selectOption({ label: bank.name });
  await page.getByRole("button", { name: "Record expense" }).click();
  await expect(page.getByRole("heading", { name: /EXP-/ })).toBeVisible();
});
