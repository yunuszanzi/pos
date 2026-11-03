import { expect, test, type Page } from "@playwright/test";
import { callApi, createTestBusiness, inviteTestStaff, testPassword, uniqueEmail } from "../integration/helpers";

// v0.1 acceptance tests (technical-plan 6) against the real UI, API and local Supabase. No mocks.

async function signInThroughUi(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(testPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: /Welcome/ }).waitFor();
}

test("1. owner signs up, creates the business, a branch, a terminal and a cashier", async ({ page }) => {
  const ownerEmail = uniqueEmail("owner");
  await page.goto("/login");
  await page.getByRole("button", { name: "Create a new business" }).click();
  await page.getByLabel("Email").fill(ownerEmail);
  await page.getByLabel("Password").fill(testPassword);
  await page.getByRole("button", { name: "Create owner account" }).click();

  await page.getByRole("heading", { name: "Set up your business" }).waitFor();
  await page.getByLabel("Legal name").fill("Example Traders (Pvt) Ltd");
  await page.getByLabel("Trade name").fill("Example Traders");
  await page.getByLabel("Branch name").fill("Main Branch");
  await page.getByLabel("Branch code").fill("KHI");
  await page.getByLabel("Default stock location").fill("Main Store");
  await page.getByLabel("Terminal name").fill("Register 1");
  await page.getByLabel("Invoice prefix").fill("INV-KHI");
  await page.getByLabel("4–6 digit PIN").fill("2468");
  await page.getByRole("button", { name: "Create business" }).click();
  await page.getByRole("heading", { name: /Welcome/ }).waitFor();
  await expect(page.getByLabel("Terminal")).toContainText("Register 1");

  await page.getByRole("link", { name: "Users", exact: true }).click();
  await page.getByLabel("Full name").fill("Cashier One");
  await page.getByLabel("Email").fill(uniqueEmail("cashier"));
  await page.getByLabel("Role").selectOption({ label: "Cashier" });
  await page.getByLabel("Branch").selectOption({ label: "Main Branch" });
  await page.getByLabel("Terminal PIN (optional)").fill("1357");
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByRole("status")).toContainText("Invitation sent");
  await expect(page.getByRole("cell", { name: "Cashier One" })).toBeVisible();
});

test("2. cashier cannot open Users or Settings, in the UI or by calling the API", async ({ page }) => {
  const business = await createTestBusiness();
  const cashier = await inviteTestStaff(business, "Cashier");
  await signInThroughUi(page, cashier.email);

  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  for (const path of ["/users", "/settings"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  }
  for (const path of ["/api/v1/users", "/api/v1/settings"]) {
    const response = await page.request.get(path, { headers: { Authorization: `Bearer ${cashier.token}` } });
    expect(response.status(), path).toBe(403);
  }
});

test("3. PIN switch changes the active user; audit log shows both logins", async ({ page }) => {
  const business = await createTestBusiness();
  const cashier = await inviteTestStaff(business, "Cashier");
  expect((await callApi(cashier.token, "POST", "/auth/login-event")).status).toBe(200);
  await signInThroughUi(page, business.ownerEmail);
  const nav = page.getByRole("navigation", { name: "Main navigation" });

  await page.getByRole("button", { name: "Switch user" }).click();
  await page.getByLabel("Staff email").fill(cashier.email);
  await page.getByLabel("PIN").fill(cashier.pin);
  await page.getByRole("button", { name: "Switch terminal user" }).click();
  await expect(page.locator(".topbar-user")).toHaveText("Cashier");
  await expect(nav.getByRole("link", { name: "Audit history" })).toHaveCount(0);

  await page.getByRole("button", { name: "Switch user" }).click();
  await page.getByLabel("Staff email").fill(business.ownerEmail);
  await page.getByLabel("PIN").fill(business.ownerPin);
  await page.getByRole("button", { name: "Switch terminal user" }).click();
  await expect(nav.getByRole("link", { name: "Audit history" })).toBeVisible();

  await nav.getByRole("link", { name: "Audit history" }).click();
  const rowFor = (action: string, userId: string) => page.getByRole("row").filter({ hasText: action }).filter({ hasText: userId });
  await expect(rowFor("login", business.ownerId).first()).toBeVisible();
  await expect(rowFor("login", cashier.id).first()).toBeVisible();
  await expect(rowFor("pin_switch_out", business.ownerId).first()).toBeVisible();
  await expect(rowFor("pin_switch_in", cashier.id).first()).toBeVisible();
});
