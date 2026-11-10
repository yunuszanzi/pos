import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, firstLocationId } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.5 slice 3 against the real UI, API and local Supabase: the supplier's bill for goods already received, with freight and input tax.

test("3. a supplier bill takes freight into the cost of stock, records input tax and makes the payable", async ({ page }) => {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  const supplier = await callApi(business.ownerToken, "POST", "/suppliers", { body: { name: "Karachi Balloon Mills", phone: "0300-1112222", termsDays: 30 } });
  expect(supplier.status).toBe(201);
  // 2 cartons of 200 arrive at Rs 3,200.00 a carton, with no bill yet.
  const received = await callApi(business.ownerToken, "POST", "/goods-receipts", {
    idempotencyKey: `rcv-${crypto.randomUUID()}`,
    body: { supplierId: supplier.body.id, locationId: await firstLocationId(business), lines: [{ variantId: product.variantId, unitId: product.cartonId, quantity: "2", unitCostPaisa: 320_000 }] },
  });
  expect(received.status, JSON.stringify(received.body)).toBe(201);

  await signInThroughUi(page, business.ownerEmail);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Supplier bills", exact: true }).click();
  await page.getByRole("link", { name: "Enter a supplier bill" }).click();

  await page.getByLabel("Find a supplier").fill("Karachi");
  await page.getByRole("button", { name: /Karachi Balloon Mills/ }).click();
  await page.getByLabel("Supplier's invoice number").fill("KBM-1001");
  const line = page.getByRole("group", { name: /^Received GRN-.* A$/ });
  await line.getByRole("checkbox").check();
  await expect(line.getByLabel("Billed (Carton)")).toHaveValue("2");
  await expect(line.getByLabel("Price on their invoice (Rs)")).toHaveValue("3200.00");
  await line.getByLabel("Tax (%)").fill("18");

  // Freight of Rs 400.00 is part of the cost: Rs 6,800.00 over 400 pieces is Rs 17.00 a piece. The tax is not.
  await page.getByRole("button", { name: "Add a charge" }).click();
  await page.getByRole("group", { name: "Charge 1" }).getByLabel("Amount (Rs)").fill("400.00");
  await expect(line).toContainText("costs Rs 17.00 a piece with freight");
  await expect(page.getByTestId("bill-total")).toHaveText("Rs 7,952.00"); // 6,400.00 + 400.00 + 18% of 6,400.00
  await page.getByRole("button", { name: "Enter bill" }).click();

  await expect(page.getByRole("heading", { name: /supplier bill/ })).toBeVisible();
  await expect(page.getByTestId("bill-total")).toHaveText("Rs 7,952.00");
  await expect(page.getByRole("table", { name: "Bill items" })).toContainText("Rs 1,152.00 (18%)");
  await expect(page.getByRole("table", { name: "Bill items" })).toContainText("Rs 400.00");

  // The goods are billed; the shop owes the whole bill; stock now costs Rs 17.00 a piece.
  const owed = (await callApi(business.ownerToken, "GET", `/suppliers/${supplier.body.id}`)).body.balancePaisa;
  expect(owed).toBe(795_200);
  expect((await callApi(business.ownerToken, "GET", "/stock/valuation")).body.rows[0]).toMatchObject({ onHand: "400", costValuePaisa: 680_000 });
  await nav.getByRole("link", { name: "Payables ageing" }).click();
  await expect(page.getByTestId("payables-total")).toHaveText("Rs 7,952.00");

  // Entering the same supplier invoice number again is refused in plain words, and nothing is waiting to be billed.
  await nav.getByRole("link", { name: "Supplier bills", exact: true }).click();
  await expect(page.getByRole("table", { name: "Supplier bills" })).toContainText("KBM-1001");
  await page.getByRole("link", { name: "Enter a supplier bill" }).click();
  await page.getByLabel("Find a supplier").fill("Karachi");
  await page.getByRole("button", { name: /Karachi Balloon Mills/ }).click();
  await expect(page.getByText("Nothing received from Karachi Balloon Mills is waiting for a bill.")).toBeVisible();
});
