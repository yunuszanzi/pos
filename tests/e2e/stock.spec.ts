import { expect, test } from "@playwright/test";
import { callApi, createSimpleProduct, createTestBusiness, inviteStaffWithPermissions, inviteTestStaff, setAdjustmentThreshold } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// v0.2 acceptance tests 2 and 3 (technical-plan 6) against the real UI, API and local Supabase. No mocks.

const csv = (name: string, ...lines: string[]) => ({ name, mimeType: "text/csv", buffer: Buffer.from(lines.join("\r\n")) });
const stockNav = (page: import("@playwright/test").Page) => page.getByRole("navigation", { name: "Stock sections" });

test("2. opening stock of 10 cartons shows as 2,000 pieces", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "STK-1", 100);
  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Stock", exact: true }).click();
  await stockNav(page).getByRole("link", { name: "Opening stock" }).click();

  await page.getByLabel("CSV file").setInputFiles(csv("bad.csv", "sku,quantity,unit", "STK-1,10,Bucket", "NOPE,1,"));
  await expect(page.getByText("2 problems found")).toBeVisible();
  await expect(page.getByRole("row").filter({ has: page.getByRole("cell", { name: "2", exact: true }) })).toContainText('is not sold in "Bucket"');
  await expect(page.getByRole("button", { name: "Load opening stock" })).toBeDisabled();

  await page.getByLabel("CSV file").setInputFiles(csv("opening.csv", "sku,quantity,unit,cost", "STK-1,10,Carton,3200.00"));
  await expect(page.getByText("The file is valid.")).toBeVisible();
  await page.getByRole("button", { name: "Load opening stock" }).click();
  await expect(page.getByText("Opening stock loaded: 1 SKU in 1 location, worth Rs 32,000.00 at cost.")).toBeVisible();

  await stockNav(page).getByRole("link", { name: "Stock levels" }).click();
  const row = page.getByRole("row").filter({ hasText: "STK-1" });
  await expect(row).toContainText("2,000 Piece");
  await expect(row).toContainText("10 Carton");
  await expect(row).toContainText("Rs 32,000.00");

  await row.getByRole("link", { name: "Movements" }).click();
  await expect(page.getByRole("heading", { name: "Movements · Product STK-1" })).toBeVisible();
  const entry = page.getByRole("row").filter({ hasText: "Stock adjustment" });
  await expect(entry).toContainText("+2,000");

  // The same SKU cannot be loaded twice.
  await stockNav(page).getByRole("link", { name: "Opening stock" }).click();
  await page.getByLabel("CSV file").setInputFiles(csv("again.csv", "sku,quantity", "STK-1,5"));
  await expect(page.getByText("1 problem found")).toBeVisible();
  await expect(page.getByText('"STK-1" already has stock movements here; use a stock adjustment instead')).toBeVisible();
});

test("3. an adjustment above the threshold stays pending until a manager approves it", async ({ page, browser }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "ADJ-UI-1", 1000);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity\nADJ-UI-1,100" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  await setAdjustmentThreshold(business, 50_000); // PKR 500
  const clerk = await inviteStaffWithPermissions(business, "Stock clerk", ["catalog.view", "locations.view", "inventory.view", "inventory.adjust"]);
  const manager = await inviteTestStaff(business, "Manager");

  // The clerk removes 60 pieces worth Rs 600: over the threshold, so it waits.
  await signInThroughUi(page, clerk.email);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Stock", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "ADJ-UI-1" })).toContainText("100 Piece");
  await page.getByRole("link", { name: "Adjust stock" }).click();
  await page.getByLabel("Find a product to add").fill("ADJ-UI-1");
  await page.getByRole("button", { name: "Add ADJ-UI-1" }).click();
  const lineBox = page.getByRole("group", { name: "Line ADJ-UI-1" });
  await lineBox.getByLabel("Quantity").fill("60");
  await page.getByLabel("Note").fill("Water damage in the storeroom");
  await page.getByRole("button", { name: "Save adjustment" }).click();
  await expect(page.getByText("Adjustment sent for approval. Stock changes once it is approved.")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Damaged" })).toContainText("Waiting for approval");

  // Stock is untouched, and the clerk cannot approve their own request.
  await stockNav(page).getByRole("link", { name: "Stock levels" }).click();
  await expect(page.getByRole("row").filter({ hasText: "ADJ-UI-1" })).toContainText("100 Piece");
  await stockNav(page).getByRole("link", { name: "Adjustments" }).click();
  await page.getByRole("row").filter({ hasText: "Damaged" }).getByRole("button", { name: "View" }).click();
  await expect(page.getByText("Waiting for someone with approval rights.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  const denied = await page.request.post(`/api/v1/stock-adjustments/${(await callApi(business.ownerToken, "GET", "/stock-adjustments?status=pending")).body.data[0].id}/approve`, {
    headers: { Authorization: `Bearer ${clerk.token}`, "Idempotency-Key": `deny-${crypto.randomUUID()}` },
  });
  expect(denied.status()).toBe(403);

  // The manager, in a separate browser session, approves it.
  const managerPage = await (await browser.newContext()).newPage();
  await signInThroughUi(managerPage, manager.email);
  await managerPage.goto("/stock/adjustments");
  await managerPage.getByRole("row").filter({ hasText: "Damaged" }).getByRole("button", { name: "View" }).click();
  const details = managerPage.getByRole("region", { name: "Adjustment details" });
  await expect(details).toContainText("Water damage in the storeroom");
  await expect(details).toContainText("-60");
  await expect(details).toContainText("Total value: Rs 600.00");
  await details.getByRole("button", { name: "Approve" }).click();
  await expect(managerPage.getByText("Adjustment approved and posted to stock.")).toBeVisible();
  await expect(details).toContainText("Approved");

  await managerPage.goto("/stock");
  await expect(managerPage.getByRole("row").filter({ hasText: "ADJ-UI-1" })).toContainText("40 Piece");
  await managerPage.getByRole("link", { name: "Movements" }).click();
  // Match the quantity cell itself: user names are random text and could contain "-60" too.
  await expect(managerPage.getByRole("row").filter({ has: managerPage.getByRole("cell", { name: "-60", exact: true }) })).toContainText("40");
  await managerPage.context().close();
});

test("a manager can reject an adjustment with a reason, leaving stock unchanged", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "REJ-1", 1000);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity\nREJ-1,50" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  await setAdjustmentThreshold(business, 0);
  const clerk = await inviteStaffWithPermissions(business, "Stock clerk", ["catalog.view", "inventory.view", "inventory.adjust"]);
  const pending = await callApi(clerk.token, "POST", "/stock-adjustments", {
    idempotencyKey: `rej-${crypto.randomUUID()}`,
    body: { locationId: (await callApi<Array<{ id: string }>>(business.ownerToken, "GET", "/locations")).body[0].id, reason: "theft", lines: [{ variantId: (await callApi(business.ownerToken, "GET", "/products?q=REJ-1")).body.data[0].variants[0].id, unitId: (await callApi<Array<{ id: string; name: string }>>(business.ownerToken, "GET", "/units")).body.find((unit) => unit.name === "Piece")!.id, quantity: "-20" }] },
  });
  expect(pending.body.status).toBe("pending");

  await signInThroughUi(page, business.ownerEmail);
  await page.goto(`/stock/adjustments?open=${pending.body.id}`);
  await page.getByRole("button", { name: "Reject…" }).click();
  await page.getByLabel("Reason for rejecting").fill("Recount first");
  await page.getByRole("button", { name: "Reject adjustment" }).click();
  await expect(page.getByText("Adjustment rejected. Stock was not changed.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Adjustment details" })).toContainText("Rejected: Recount first");
  await page.goto("/stock");
  await expect(page.getByRole("row").filter({ hasText: "REJ-1" })).toContainText("50 Piece");
});

test("a cashier can see stock but not adjust it, value it, or load opening stock", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "CSH-1", 1000);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity\nCSH-1,12" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  const cashier = await inviteTestStaff(business, "Cashier");
  await signInThroughUi(page, cashier.email);

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Stock", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "CSH-1" });
  await expect(row).toContainText("12 Piece");
  await expect(page.getByRole("columnheader", { name: "Value" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Adjust stock" })).toHaveCount(0);
  await expect(stockNav(page).getByRole("link", { name: "Valuation" })).toHaveCount(0);
  await expect(stockNav(page).getByRole("link", { name: "Opening stock" })).toHaveCount(0);
  for (const path of ["/stock/adjustments/new", "/stock/opening", "/stock/valuation"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  }
  const response = await page.request.get("/api/v1/stock/valuation", { headers: { Authorization: `Bearer ${cashier.token}` } });
  expect(response.status()).toBe(403);
});

test("the owner sees stock valued at cost and sale price, and nothing as of yesterday", async ({ page }) => {
  const business = await createTestBusiness();
  await createSimpleProduct(business, "VAL-UI", 100);
  await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,cost\nVAL-UI,100,10.00" }, idempotencyKey: `open-${crypto.randomUUID()}` });
  await signInThroughUi(page, business.ownerEmail);
  await page.goto("/stock/valuation");
  await expect(page.getByText("At cost: Rs 1,000.00")).toBeVisible();
  await expect(page.getByText("At sale price: Rs 500.00")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "VAL-UI" })).toContainText("100 Piece");

  const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date(Date.now() - 86_400_000));
  await page.getByLabel("As of").fill(yesterday);
  await expect(page.getByText("No stock on hand for this date.")).toBeVisible();
});
