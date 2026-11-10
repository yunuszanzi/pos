import { expect, test } from "@playwright/test";
import { createTestBusiness } from "../integration/helpers";
import { signInThroughUi } from "./helpers";

test("modules that are not built yet are listed as under development and cannot be opened", async ({ page }) => {
  const business = await createTestBusiness();
  await signInThroughUi(page, business.ownerEmail);

  const soon = page.getByRole("navigation", { name: "Coming soon" });
  await expect(soon).toContainText("Offline till");
  await expect(soon.getByText("Under development").first()).toBeVisible();
  await expect(soon.getByRole("link")).toHaveCount(0);

  // Clicking one does nothing: the page does not change.
  const before = page.url();
  await soon.getByText("Offline till").click();
  expect(page.url()).toBe(before);
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();

  // Every real menu entry still opens a page with content.
  const main = page.getByRole("navigation", { name: "Main navigation" });
  const hrefs = await main.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")!));
  for (const href of hrefs.filter((value) => value !== "/pos")) {
    await page.goto(href);
    await expect(page.locator("main .content, main .full-message").first()).toBeVisible();
  }
});
