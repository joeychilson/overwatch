import { test, expect } from "@playwright/test";
import { desktop, sessions } from "./desktop";

const history = Array.from({ length: 123 }, (_, index) => ({
  ...sessions[index % sessions.length],
  id: `page-${index}`,
  title: `History session ${String(index).padStart(3, "0")}`,
  updatedAt: Date.now() - index * 1000,
}));

test("session pages keep full-scope sorting, navigation and export", async ({ page }) => {
  await desktop(page, { sessions: history });
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  const table = page.getByRole("table", { name: "Sessions", exact: true });
  await expect(table.locator("tbody [data-row-id]")).toHaveCount(50);
  await expect(page.getByRole("navigation", { name: "Session pages" })).toContainText(
    "1–50 of 123 sessions",
  );
  await page.screenshot({ path: `test-results/session-pages-${test.info().project.name}.png` });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    table.getByRole("button", { name: "History session 050", exact: true }),
  ).toBeVisible();
  await expect(table.locator("tbody [data-row-id]")).toHaveCount(50);
  await table.getByRole("button", { name: "History session 099", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Session navigation" })).toContainText(
    "100 of 123",
  );
  await page.getByRole("button", { name: "Next session", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "History session 100", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to sessions", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Session pages" })).toContainText(
    "51–100 of 123 sessions",
  );
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect
    .poll(async () => {
      const raw = await page.locator("html").getAttribute("data-exported-file");
      return raw ? JSON.parse(raw).content.split("\r\n").length : 0;
    })
    .toBe(124);
  await table.getByRole("button", { name: "Session", exact: true }).click();
  await expect(table.getByRole("columnheader", { name: "Session", exact: true })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await expect(
    table.getByRole("button", { name: "History session 000", exact: true }),
  ).toBeVisible();
  const requests = JSON.parse(
    (await page.locator("html").getAttribute("data-history-requests")) ?? "[]",
  );
  expect(requests.some((request: { command: string }) => request.command === "get_sessions")).toBe(
    true,
  );
  expect(
    requests
      .filter((request: { command: string }) => request.command === "get_sessions")
      .every((request: { args: { query: { limit: number } } }) => request.args.query.limit <= 50),
  ).toBe(true);
});
