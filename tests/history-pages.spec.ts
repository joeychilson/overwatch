import { test, expect } from "@playwright/test";
import { desktop, sessions } from "./desktop";

const history = Array.from({ length: 123 }, (_, index) => ({
  ...sessions[index % sessions.length],
  id: `page-${index}`,
  title: `History session ${String(index).padStart(3, "0")}`,
  updatedAt: Date.now() - index * 1000,
}));

test("infinite sessions load bounded batches and keep full-scope navigation and export", async ({
  page,
}) => {
  await desktop(page, { sessions: history });
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  const table = page.getByRole("table", { name: "Sessions", exact: true });
  const scroll = page.locator('[data-slot="page-scroll"]');
  await expect(page.getByRole("status").filter({ hasText: "50 of 123 sessions" })).toBeAttached();
  expect(await table.locator("tbody [data-row-id]").count()).toBeLessThan(40);
  await page.screenshot({
    path: `/tmp/overwatch-ui-review/infinite-sessions-${test.info().project.name}.png`,
  });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect
    .poll(async () => {
      const raw = await page.locator("html").getAttribute("data-exported-file");
      return raw ? JSON.parse(raw).content.split("\r\n").length : 0;
    })
    .toBe(124);
  await expect
    .poll(async () => {
      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      return await table
        .getByRole("button", { name: "History session 121", exact: true })
        .isVisible();
    })
    .toBe(true);
  await table.getByRole("button", { name: "History session 121", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Session navigation" })).toContainText(
    "122 of 123",
  );
  await page.getByRole("button", { name: "Next session", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "History session 122", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to sessions", exact: true }).click();
  await expect(
    table.getByRole("button", { name: "History session 121", exact: true }),
  ).toBeFocused();
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
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
  const lists = requests.filter(
    (request: { command: string }) => request.command === "get_sessions",
  );
  expect(
    lists.every(
      (request: { args: { query: { limit: number } } }) => request.args.query.limit <= 50,
    ),
  ).toBe(true);
  expect(
    lists.some(
      (request: { args: { query: { offset: number } } }) => request.args.query.offset === 100,
    ),
  ).toBe(true);
});

test("history events refresh only the affected reader", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page
    .locator('[data-row-id="session-0"]')
    .getByRole("button", { name: sessions[0].title, exact: true })
    .click();
  await expect(page.getByRole("heading", { name: sessions[0].title, exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-transcript-requests", "1");
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("fixture-index-change", {
        detail: { sessions: ["session-12"], progress: false },
      }),
    ),
  );
  // Wait for the scope refresh to finish, ensuring the event was processed.
  await expect
    .poll(
      async () =>
        JSON.parse(
          (await page.locator("html").getAttribute("data-history-requests")) ?? "[]",
        ).filter((r: { command: string }) => r.command === "get_history_status").length,
    )
    .toBeGreaterThan(1);
  await expect(page.locator("html")).toHaveAttribute("data-transcript-requests", "1");
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("fixture-index-change", {
        detail: { sessions: ["session-0"], progress: true },
      }),
    ),
  );
  await expect(page.locator("html")).toHaveAttribute("data-transcript-requests", "1");
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("fixture-index-change", {
        detail: { sessions: ["session-0"], progress: false },
      }),
    ),
  );
  await expect(page.locator("html")).toHaveAttribute("data-transcript-requests", "2");
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("fixture-index-change", {
        detail: { sessions: null, progress: false },
      }),
    ),
  );
  await expect(page.locator("html")).toHaveAttribute("data-transcript-requests", "3");
});

test("Tab traversal reaches sessions beyond the first batch", async ({ page }) => {
  await desktop(page, { sessions: history });
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  const table = page.getByRole("table", { name: "Sessions", exact: true });
  await table.getByRole("button", { name: "History session 000", exact: true }).focus();
  for (let i = 0; i < 55; i++) {
    await page.keyboard.press("Tab");
    await expect(
      table.getByRole("button", {
        name: `History session ${String(i + 1).padStart(3, "0")}`,
        exact: true,
      }),
    ).toBeFocused();
  }
  await expect(
    table.getByRole("button", { name: "History session 055", exact: true }),
  ).toBeFocused();
});
