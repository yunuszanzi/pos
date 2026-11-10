import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, firstLocationId } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.5 slice 4 against the real UI, API and local Supabase: paying a supplier, and sending goods back to them.

test("4. a supplier is paid part of a bill, then goods go back and the credit comes off the bill", async ({ page }) => {
  const business = await createTestBusiness();
  const product = await createSimpleProduct(business, "A", 100);
  const supplier = await callApi(business.ownerToken, "POST", "/suppliers", { body: { name: "Karachi Balloon Mills", phone: "0300-1112222" } });
  expect(supplier.status).toBe(201);
  // 100 pieces at Rs 10.00 arrive and are billed: the shop owes Rs 1,000.00.
  const received = await callApi(business.ownerToken, "POST", "/goods-receipts", {
    idempotencyKey: `rcv-${crypto.randomUUID()}`,
    body: { supplierId: supplier.body.id, locationId: await firstLocationId(business), lines: [{ variantId: product.variantId, unitId: product.pieceId, quantity: "100", unitCostPaisa: 1_000 }] },
  });
  expect(received.status, JSON.stringify(received.body)).toBe(201);
  const bill = await callApi(business.ownerToken, "POST", "/purchase-bills", {
    idempotencyKey: `bill-${crypto.randomUUID()}`,
    body: { supplierId: supplier.body.id, supplierInvoiceNo: "KBM-1001", billDate: new Date().toLocaleDateString("en-CA"), lines: [{ receiptLineId: received.body.receipt.lines[0].id, quantity: "100", unitCostPaisa: 1_000 }] },
  });
  expect(bill.status, JSON.stringify(bill.body)).toBe(201);

  await signInThroughUi(page, business.ownerEmail);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Suppliers", exact: true }).click();
  await page.getByRole("row", { name: /Karachi Balloon Mills/ }).getByRole("link", { name: "Ledger" }).click();
  await expect(page.getByTestId("supplier-balance")).toHaveText("Rs 1,000.00");
  await expect(page.getByRole("table", { name: "Open bills" })).toContainText("KBM-1001");

  // Pay Rs 300.00 of it. The box offers the whole amount owed until something else is typed.
  await page.getByRole("button", { name: "Pay supplier" }).click();
  await expect(page.getByTestId("supplier-owed")).toHaveText("Rs 1,000.00");
  await expect(page.getByLabel("Amount paid (Rs)")).toHaveValue("1000.00");
  await page.getByLabel("Amount paid (Rs)").fill("300.00");
  await page.getByLabel("Reference (transfer or cheque number)").fill("TRF-9001");
  await page.getByRole("button", { name: /^Pay Rs 300.00/ }).click();
  await expect(page.getByTestId("supplier-paid")).toHaveText("Rs 300.00");
  await expect(page.getByTestId("supplier-owed-after")).toHaveText("Rs 700.00");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("supplier-balance")).toHaveText("Rs 700.00");
  await expect(page.getByRole("table", { name: "Open bills" }).getByRole("row").nth(1)).toContainText("Rs 700.00");

  // 20 pieces go back at the billed price: Rs 200.00 comes off the bill.
  await nav.getByRole("link", { name: "Goods receipts", exact: true }).click();
  await page.getByRole("table", { name: "Goods receipts" }).getByRole("link", { name: /GRN-/ }).click();
  await page.getByRole("link", { name: "Return goods" }).click();
  await page.getByRole("group", { name: "Line A" }).getByLabel(/^Going back/).pressSequentially("2x0"); // letters never appear
  await expect(page.getByRole("group", { name: "Line A" }).getByLabel(/^Going back/)).toHaveValue("20");
  await expect(page.getByTestId("return-credit")).toHaveText("Rs 200.00");
  await page.getByLabel("Reason").fill("Damaged in transit");
  await page.getByRole("button", { name: "Send goods back" }).click();

  await expect(page.getByRole("heading", { name: /purchase return/ })).toBeVisible();
  await expect(page.getByTestId("return-total")).toHaveText("Rs 200.00");
  await expect(page.getByTestId("return-settled")).toHaveText("Rs 200.00");
  expect((await callApi(business.ownerToken, "GET", `/suppliers/${supplier.body.id}`)).body.balancePaisa).toBe(50_000);
  expect((await callApi(business.ownerToken, "GET", "/stock/valuation")).body.rows[0]).toMatchObject({ onHand: "80", costValuePaisa: 80_000 });

  // The bill shows what has settled it, and both documents are listed.
  await nav.getByRole("link", { name: "Supplier bills", exact: true }).click();
  await page.getByRole("link", { name: /BILL-/ }).click();
  await expect(page.getByTestId("bill-outstanding")).toHaveText("Rs 500.00");
  await nav.getByRole("link", { name: "Payments made", exact: true }).click();
  await expect(page.getByRole("table", { name: "Payments made" })).toContainText("TRF-9001");
  await nav.getByRole("link", { name: "Purchase returns", exact: true }).click();
  await expect(page.getByRole("table", { name: "Purchase returns" })).toContainText("Damaged in transit");
});
