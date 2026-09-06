import { test, expect } from "@playwright/test";
import { desktop } from "./desktop";

for (const width of [640, 420]) {
  test(`primary workflows fit a ${width}px window`, async ({ page }) => {
    await desktop(page, { longNames: true });
    await page.setViewportSize({ width, height: 850 });
    await page.goto("/");
    for (const dark of [true, false]) {
      await page.evaluate(
        (value) => document.documentElement.classList.toggle("dark", value),
        dark,
      );
      for (const view of ["Overview", "Sessions", "Models", "Subscriptions", "Connections"]) {
        await page
          .getByRole("navigation", { name: "Main navigation" })
          .getByRole("button", { name: view, exact: true })
          .click();
        await expect(page.getByRole("heading", { name: view, exact: true })).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator("main > header")
              .evaluate((element) => element.scrollWidth <= element.clientWidth),
          )
          .toBe(true);
        await expect
          .poll(() =>
            page
              .locator('[data-slot="page-scroll"]')
              .evaluate((element) => element.scrollWidth <= element.clientWidth),
          )
          .toBe(true);
      }
    }
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Overview", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Date range" }).click();
    await page.getByRole("option", { name: "Last 7 days", exact: true }).click();
    await expect(page.getByRole("listbox")).toBeHidden();
    await page.screenshot({
      path: `test-results/overview-${width}-${test.info().project.name}.png`,
    });
    await page.setViewportSize({ width: 1440, height: 850 });
    await expect(page.getByRole("button", { name: "Collapse sidebar", exact: true })).toBeVisible();
  });
}
