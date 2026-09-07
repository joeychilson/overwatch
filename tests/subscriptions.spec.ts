import { test, expect } from "@playwright/test";
import { desktop } from "./desktop";

test("overview shows a compact warning above the stats for an imminent limit", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  const warning = page.getByRole("status", { name: "Subscription warnings" });
  await expect(warning).toContainText("Codex · Weekly");
  await expect(warning).toContainText("44% remaining");
  await expect(warning).toContainText("May reach limit in");
  await expect(warning).toContainText("Resets in");
  const stats = page.getByText("Total tokens", { exact: true });
  expect((await warning.boundingBox())!.y).toBeLessThan((await stats.boundingBox())!.y);
  await page.screenshot({
    path: `test-results/subscription-warning-${test.info().project.name}.png`,
  });
  await page.setViewportSize({ width: 900, height: 640 });
  await expect(warning).toBeVisible();
  expect(
    await page
      .locator('[data-slot="page-scroll"]')
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await warning.getByRole("button", { name: "View subscriptions" }).click();
  await expect(page.getByRole("heading", { name: "Subscriptions", exact: true })).toBeVisible();
});

for (const quotaState of ["collecting", "stale", "expired", undefined] as const) {
  test(`overview hides subscription warnings for ${quotaState ?? "distant"} limits`, async ({
    page,
  }) => {
    await desktop(page, { quotaState, slowQuota: true });
    await page.goto("/");
    await expect(page.getByText("Total tokens", { exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: "Subscription warnings" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Subscriptions", exact: true })).toHaveCount(0);
  });
}

test("a single allowance fills the summary row and has no redundant history selector", async ({
  page,
}) => {
  await desktop(page, { singleAllowance: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Subscriptions", exact: true }).click();
  await expect(page.getByRole("meter")).toHaveCount(1);
  await expect(page.getByRole("group", { name: "History window" })).toHaveCount(0);
  await expect(page.getByLabel("Weekly usage history", { exact: true })).toBeVisible();
  const summary = await page
    .getByRole("region", { name: "Weekly allowance", exact: true })
    .boundingBox();
  const history = await page
    .getByRole("region", { name: "Allowance history", exact: true })
    .boundingBox();
  expect(summary!.width).toBe(history!.width);
});

test("subscription summaries switch history without changing the allowance readings", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Subscriptions", exact: true }).click();
  await expect(page.getByRole("meter", { name: "5 hour quota remaining" })).toHaveAttribute(
    "aria-valuenow",
    "58",
  );
  await expect(page.getByRole("meter", { name: "Weekly quota remaining" })).toHaveAttribute(
    "aria-valuenow",
    "44",
  );
  await expect(page.getByRole("region", { name: "Weekly allowance", exact: true })).toContainText(
    "May run out",
  );
  await expect(page.getByLabel("5 hour usage history", { exact: true })).toBeVisible();
  const history = page.getByRole("group", { name: "History window" });
  await history.getByRole("button", { name: "Weekly", exact: true }).click();
  await expect(page.getByLabel("Weekly usage history", { exact: true })).toBeVisible();
  await expect(history.getByRole("button", { name: "Weekly", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("5 hour usage history", { exact: true })).toHaveCount(0);
  await expect(page.getByText("240 credits", { exact: true })).toBeVisible();
  await page
    .getByRole("group", { name: "Subscription provider" })
    .getByRole("button", { name: "Claude Code", exact: true })
    .click();
  await expect(page.getByText("Connect your subscription", { exact: true })).toBeVisible();
  await expect(history).toHaveCount(0);
  await page
    .getByRole("group", { name: "Subscription provider" })
    .getByRole("button", { name: "Codex", exact: true })
    .click();
  await expect(page.getByLabel("5 hour usage history", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 900, height: 640 });
  await expect
    .poll(() =>
      page
        .locator('[data-slot="page-scroll"]')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Overwatch overview" }).locator("img"),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("removing connection data requires confirmation and explains provider sign-ins", async ({
  page,
}) => {
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Subscriptions", exact: true }).click();
  await page.getByRole("button", { name: "Remove saved connection data" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove Codex connection data?" });
  await expect(dialog).toContainText("Provider sign-in files are not changed");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Remove saved connection data" }).click();
  await dialog.getByRole("button", { name: "Remove data", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Quota readings from local session logs", { exact: true }),
  ).toBeVisible();
});

for (const state of ["collecting", "stale", "expired"] as const) {
  test(`subscription ${state} readings retain their usage and show the next action`, async ({
    page,
  }) => {
    await desktop(page, { quotaState: state });
    await page.goto("/");
    await page.getByRole("button", { name: "Subscriptions", exact: true }).click();
    const allowance = page.getByRole("region", { name: "5 hour allowance", exact: true });
    await expect(allowance.getByRole("meter")).toHaveAttribute("aria-valuenow", "58");
    if (state === "collecting") {
      await expect(allowance).toContainText("Pace estimate needs more readings.");
      await expect(page.getByRole("meter", { name: "Weekly quota remaining" })).toHaveAttribute(
        "aria-valuenow",
        "100",
      );
      await expect(
        page.getByText("The history chart will appear after another usage reading."),
      ).toBeVisible();
    } else {
      await expect(allowance).toContainText(state === "stale" ? "Refresh needed" : "Window ended");
      await expect(allowance).not.toContainText("May run out");
      if (state === "expired") await expect(allowance).toContainText("Ended");
    }
    await expect(page.getByRole("button", { name: "Refresh usage", exact: true })).toBeEnabled();
  });
}
