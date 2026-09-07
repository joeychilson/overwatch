import { test, expect } from "@playwright/test";
import { desktop, sessions } from "./desktop";

test("optional filters share their scope with counts and exports", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Session filters" })).toBeVisible();
  await page.getByRole("checkbox", { name: "With failed tool calls" }).check();
  await page.getByRole("combobox", { name: "Used tool" }).click();
  await page.getByRole("option", { name: "exec_command", exact: true }).click();
  await page.screenshot({
    animations: "disabled",
    path: `test-results/session-filters-open-${test.info().project.name}.png`,
  });
  await page.getByRole("button", { name: "Close filters" }).click();
  await expect(page.getByRole("status").filter({ hasText: "sessions" })).toContainText(
    "10 of 10 sessions",
  );
  await page.screenshot({
    animations: "disabled",
    path: `test-results/session-filters-active-${test.info().project.name}.png`,
  });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect
    .poll(async () => {
      const raw = await page.locator("html").getAttribute("data-exported-file");
      return raw ? JSON.parse(raw).content.split("\r\n").length : 0;
    })
    .toBe(11);
  await page.getByRole("button", { name: "Clear failure filter" }).click();
  await expect(page.getByRole("status").filter({ hasText: "sessions" })).toContainText(
    "48 of 48 sessions",
  );
  await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
  await page.getByRole("combobox", { name: "Used model" }).click();
  await page.getByRole("option", { name: "Claude Opus 5", exact: true }).click();
  await page.getByRole("button", { name: "Close filters" }).click();
  await expect(page.getByRole("status").filter({ hasText: "sessions" })).toContainText(
    "16 of 16 sessions",
  );
});

test("command search opens every match in Sessions", async ({ page }) => {
  await desktop(page, {
    sessions: Array.from({ length: 75 }, (_, i) => ({
      ...sessions[i % sessions.length],
      id: `command-${i}`,
      title: `Shared discovery ${i}`,
    })),
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Search anything" }).click();
  await page.getByRole("combobox", { name: "Search pages and sessions" }).fill("Shared discovery");
  await expect(page.getByRole("button", { name: "See all 75 matching sessions" })).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: `test-results/command-all-matches-${test.info().project.name}.png`,
  });
  await page.getByRole("button", { name: "See all 75 matching sessions" }).click();
  await expect(
    page.getByRole("textbox", { name: "Search sessions, projects, or models…" }),
  ).toHaveValue("Shared discovery");
  await expect(page.getByRole("status").filter({ hasText: "sessions" })).toContainText(
    "50 of 75 sessions",
  );
});
