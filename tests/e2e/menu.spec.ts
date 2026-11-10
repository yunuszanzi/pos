import { expect, test } from "@playwright/test";
import { createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

test("a module with no page yet is not linked, and with none planned the menu has no 'coming soon' list; every entry opens a page", async ({ page }) => {
  const business = await createTestBusiness();
  await signInThroughUi(page, business.ownerEmail);

  // Every module on the roadmap has a page now, so nothing is listed as under development. (When one is announced, src/app/plannedModules.ts
  // lists it again, unlinked, until its page ships.)
  await expect(page.getByRole("navigation", { name: "Coming soon" })).toHaveCount(0);

  // Every real menu entry still opens a page with content.
  const main = page.getByRole("navigation", { name: "Main navigation" });
  const hrefs = await main.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")!));
  for (const href of hrefs.filter((value) => value !== "/pos")) {
    await page.goto(href);
    await expect(page.locator("main .content, main .full-message").first()).toBeVisible();
  }
});
