import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.9 acceptance test 1 (technical-plan 6) against the real UI, API and local Supabase: transfer 20 cartons, the source drops on
// dispatch, the destination rises on receipt, and in-transit shows between.

test("1. transfer 20 cartons: source drops on dispatch, destination rises on receipt, in transit shows between", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "TRF-1", 100);
  const stocked = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nTRF-1,50,Carton,3200.00" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  expect(stocked.status).toBe(201);
  expect((await callApi(business.ownerToken, "POST", "/locations", { body: { branchId: business.branchId, name: "Warehouse", type: "warehouse" } })).status).toBe(201);

  await signInThroughUi(page, business.ownerEmail);
  await page.goto("/transfers/new");
  await page.getByLabel("To", { exact: true }).selectOption({ label: "Warehouse" });
  await page.getByLabel("Find a product to add").fill("TRF-1");
  await page.getByRole("button", { name: "Add TRF-1" }).click();
  const line = page.getByRole("group", { name: "Line TRF-1" });
  await line.getByLabel("Unit").selectOption({ label: "Carton" });
  await line.getByLabel("Quantity").fill("20");
  await page.getByRole("button", { name: "Save transfer" }).click();

  await expect(page.getByTestId("transfer-status")).toHaveText("Requested");
  const transferUrl = page.url();
  // Writing it moved nothing: 50 cartons = 10,000 pieces.
  await page.goto("/stock");
  await expect(page.getByRole("row").filter({ hasText: "TRF-1" })).toContainText("10,000 Piece");

  // Sent: the source drops by 20 cartons (4,000 pieces) and they show as in transit.
  await page.goto(transferUrl);
  await page.getByRole("button", { name: /^Send/ }).click();
  await expect(page.getByTestId("transfer-status")).toHaveText("In transit");
  await page.goto("/stock");
  const row = page.getByRole("row").filter({ hasText: "TRF-1" });
  await expect(row).toContainText("6,000 Piece");
  await expect(page.getByTestId("in-transit-TRF-1")).toHaveText("4,000 in transit");
  await page.goto("/transfers");
  await expect(page.getByRole("table", { name: "In transit" })).toContainText("4,000");

  // Received: nothing is in transit and the warehouse holds them.
  await page.goto(transferUrl);
  await page.getByRole("button", { name: /^Receive into/ }).click();
  await expect(page.getByTestId("transfer-status")).toHaveText("Received");
  await page.goto("/stock");
  await expect(page.getByTestId("in-transit-TRF-1")).toHaveCount(0);
  const warehouse = (await callApi(business.ownerToken, "GET", "/locations")).body.find((location: { name: string }) => location.name === "Warehouse");
  const there = await callApi(business.ownerToken, "GET", `/stock?q=TRF-1&locationId=${warehouse.id}`);
  expect(there.body.data[0].onHand).toBe("4000");
});
