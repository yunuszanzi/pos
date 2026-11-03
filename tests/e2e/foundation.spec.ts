import { expect, test, type Page, type Route } from "@playwright/test";

const accessToken = "e2e-access-token";
const ownerId = "11111111-1111-4111-8111-111111111111";
const cashierId = "22222222-2222-4222-8222-222222222222";
const businessId = "33333333-3333-4333-8333-333333333333";
const terminalId = "44444444-4444-4444-8444-444444444444";

async function mockSupabaseSignIn(page: Page) {
  await page.route("**/auth/v1/token?grant_type=password", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: accessToken,
        refresh_token: "e2e-refresh-token",
        expires_in: 3600,
        token_type: "bearer",
        user: { id: ownerId, email: "owner@example.test", aud: "authenticated", role: "authenticated" },
      }),
    });
  });
}

test("owner can complete first-run setup and create a cashier", async ({ page }) => {
  let configured = false;
  await mockSupabaseSignIn(page);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/me") {
      await route.fulfill({ json: configured
        ? { authUserId: ownerId, email: "owner@example.test", userId: ownerId, activeUserId: ownerId, activeUserName: "Owner", activeUserEmail: "owner@example.test", businessId, roleId: "owner-role", terminalId: null, permissions: ["*"] }
        : { authUserId: ownerId, email: "owner@example.test", userId: null, activeUserId: null, activeUserName: null, activeUserEmail: null, businessId: null, roleId: null, terminalId: null, permissions: [] } });
      return;
    }
    if (url.pathname === "/api/v1/org/setup" && request.method() === "POST") {
      configured = true;
      await route.fulfill({ status: 201, json: { business: { id: businessId } } });
      return;
    }
    if (url.pathname === "/api/v1/auth/login-event") {
      await route.fulfill({ json: { recorded: true } });
      return;
    }
    if (url.pathname === "/api/v1/users" && request.method() === "POST") {
      await route.fulfill({ status: 201, json: { id: cashierId, email: "cashier@example.test", displayName: "Cashier", roleId: "cashier-role", active: true } });
      return;
    }
    if (url.pathname === "/api/v1/users") {
      await route.fulfill({ json: { data: [], page: 1, pageSize: 25 } });
      return;
    }
    if (url.pathname === "/api/v1/roles") {
      await route.fulfill({ json: [{ id: "cashier-role", name: "Cashier", isSystem: true }, { id: "manager-role", name: "Manager", isSystem: true }] });
      return;
    }
    if (url.pathname === "/api/v1/branches") {
      await route.fulfill({ json: [{ id: "branch-id", name: "Main Branch", code: "KHI", active: true }] });
      return;
    }
    if (url.pathname === "/api/v1/terminals") {
      await route.fulfill({ json: [{ id: terminalId, branchId: "branch-id", name: "Register 1", defaultPrintFormat: "pos_80mm", active: true }] });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Set up your business" }).waitFor();
  await page.getByLabel("Legal name").fill("Example Traders");
  await page.getByLabel("Trade name").fill("Example");
  await page.getByLabel("Branch name").fill("Main Branch");
  await page.getByLabel("Branch code").fill("KHI");
  await page.getByLabel("Default stock location").fill("Main Store");
  await page.getByLabel("Terminal name").fill("Register 1");
  await page.getByLabel("Invoice prefix").fill("INV-KHI");
  await page.getByLabel("4–6 digit PIN").fill("2468");
  await page.getByRole("button", { name: "Create business" }).click();
  await page.getByRole("heading", { name: /Welcome/ }).waitFor();
  await page.getByRole("link", { name: "Users", exact: true }).click();
  await page.getByLabel("Full name").fill("Cashier");
  await page.getByLabel("Email").fill("cashier@example.test");
  await page.getByLabel("Role").selectOption("cashier-role");
  await page.getByLabel("Branch").selectOption("branch-id");
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByRole("status")).toContainText("Invitation sent");
});

test("cashier cannot access Users or Settings in the UI or API", async ({ page }) => {
  await mockSupabaseSignIn(page);
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/me") {
      await route.fulfill({ json: {
        authUserId: cashierId, email: "cashier@example.test", userId: cashierId, activeUserId: cashierId,
        activeUserName: "Cashier", activeUserEmail: "cashier@example.test", businessId, roleId: "cashier-role",
        terminalId: null, permissions: ["branches.view", "locations.view", "terminals.view", "auth.pin_switch"],
      } });
      return;
    }
    if (url.pathname === "/api/v1/auth/login-event") {
      await route.fulfill({ json: { recorded: true } });
      return;
    }
    if (url.pathname === "/api/v1/terminals") {
      await route.fulfill({ json: [] });
      return;
    }
    if (["/api/v1/users", "/api/v1/settings"].includes(url.pathname)) {
      await route.fulfill({ status: 403, json: { error: { code: "PERMISSION_DENIED", message: "You do not have permission" } } });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill("cashier@example.test");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: /Welcome/ }).waitFor();
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await page.goto("/users");
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/v1/users", { headers: { Authorization: "Bearer e2e-access-token" } });
    return response.status;
  });
  expect(status).toBe(403);
});

test("PIN switch activates the terminal user and keeps audit identities", async ({ page }) => {
  let switched = false;
  await mockSupabaseSignIn(page);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/me") {
      await route.fulfill({ json: {
        authUserId: ownerId,
        email: "owner@example.test",
        userId: switched ? cashierId : ownerId,
        activeUserId: switched ? cashierId : ownerId,
        activeUserName: switched ? "Cashier" : "Owner",
        activeUserEmail: switched ? "cashier@example.test" : "owner@example.test",
        businessId,
        roleId: switched ? "cashier-role" : "owner-role",
        terminalId: switched ? terminalId : null,
        permissions: ["auth.pin_switch", "business.view", "users.view", "settings.view", "audit.view", "terminals.view"],
      } });
      return;
    }
    if (url.pathname === "/api/v1/auth/login-event") {
      await route.fulfill({ json: { recorded: true } });
      return;
    }
    if (url.pathname === "/api/v1/terminals") {
      await route.fulfill({ json: [{ id: terminalId, name: "Register 1", active: true }] });
      return;
    }
    if (url.pathname === "/api/v1/auth/pin-switch") {
      switched = true;
      await route.fulfill({ json: { pinSession: "signed-terminal-session", activeUser: { id: cashierId, email: "cashier@example.test", displayName: "Cashier" } } });
      return;
    }
    if (url.pathname === "/api/v1/audit-log") {
      await route.fulfill({ json: { data: [
        { id: "audit-out", action: "pin_switch_out", entity: "user", entityId: ownerId, createdAt: new Date().toISOString(), before: null, after: { switchedToUserId: cashierId }, userId: ownerId, terminalId },
        { id: "audit-in", action: "pin_switch_in", entity: "user", entityId: cashierId, createdAt: new Date().toISOString(), before: { switchedFromUserId: ownerId }, after: { terminalId }, userId: cashierId, terminalId },
      ], page: 1, pageSize: 25 } });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: /Welcome/ }).waitFor();
  await page.getByRole("button", { name: "Switch user" }).click();
  await page.getByLabel("Staff email").fill("cashier@example.test");
  await page.getByLabel("PIN").fill("2468");
  await page.getByRole("button", { name: "Switch terminal user" }).click();
  await expect(page.getByText("Cashier", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Audit history", exact: true }).click();
  await expect(page.getByText("pin_switch_out")).toBeVisible();
  await expect(page.getByText("pin_switch_in")).toBeVisible();
});
