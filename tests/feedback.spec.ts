import { test, expect } from "@playwright/test";
import { desktop, sessions } from "./desktop";

test("index progress stays in the empty state until usage is available", async ({ page }) => {
  await desktop(page, { sessions: [], scanning: true });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Reading local history…" })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "0 sessions indexed so far" }),
  ).toBeVisible();
  await expect(
    page.getByText("Your history stays on this device. Original files are never changed."),
  ).toBeVisible();
  await page.evaluate(
    (sessions) =>
      window.dispatchEvent(
        new CustomEvent("fixture-history-progress", { detail: { sessions, scanning: true } }),
      ),
    sessions.slice(0, 12),
  );
  await expect(
    page.getByRole("status").filter({ hasText: "12 sessions indexed so far" }),
  ).toBeVisible();
  await page.screenshot({
    path: `/tmp/overwatch-ui-review/index-progress-${test.info().project.name}.png`,
  });
  await page.getByRole("button", { name: "Manage connections" }).click();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await page.screenshot({
    path: `/tmp/overwatch-ui-review/connections-feedback-${test.info().project.name}.png`,
  });
});

test("a successful export identifies the saved path and reveals that file", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByText("Export saved", { exact: true })).toBeVisible();
  await expect(
    page.getByText("/Users/demo/Downloads/overwatch-sessions.csv", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const box = await page.locator("[data-sonner-toast]").boundingBox();
      return box ? box.y + box.height : Infinity;
    })
    .toBeLessThan(985);
  await page.screenshot({
    path: `/tmp/overwatch-ui-review/export-feedback-${test.info().project.name}.png`,
  });
  await page.getByRole("button", { name: /Reveal in Finder|Show in folder/ }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-revealed-file",
    '["/Users/demo/Downloads/overwatch-sessions.csv"]',
  );
});

for (const outcome of ["cancel", "failure"] as const)
  test(`export ${outcome} never announces success`, async ({ page }) => {
    await desktop(page, { cancelExport: outcome === "cancel", failExport: outcome === "failure" });
    await page.goto("/");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-exported-file",
      /overwatch-daily-usage/,
    );
    await expect(page.getByText("Export saved", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Reveal in Finder|Show in folder/ })).toHaveCount(
      0,
    );
    if (outcome === "failure")
      await expect(page.getByText("Could not write this export.", { exact: true })).toBeVisible();
  });
