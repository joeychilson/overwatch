import { test, expect } from "@playwright/test";
import { desktop } from "./desktop";

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
