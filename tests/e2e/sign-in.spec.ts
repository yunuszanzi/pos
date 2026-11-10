import { expect, test } from "@playwright/test";
import { createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

// Regression: after signing in, a slow "record this login" request used to finish late and send the person back to the
// start page, even though they had already opened another one. On a busy machine this made browser tests stall at random.
test("a slow sign-in record does not pull the person back to the start page after they have moved on", async ({ page }) => {
  const business = await createTestBusiness();
  // Hold the login record for 3 seconds; the request still reaches the real API.
  await page.route("**/api/v1/auth/login-event", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });

  await signInThroughUi(page, business.ownerEmail);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Products" }).click();
  await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();

  // Wait until the delayed request has finished, then check nothing moved the person.
  await page.waitForResponse("**/api/v1/auth/login-event");
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();
});
