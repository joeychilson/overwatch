/**
 * The overview.
 *
 * Its cost is an estimate from list prices, so usage with no price must read as
 * unknown rather than free. The chart is drawn by hand, so what it reads out and
 * what choosing a column opens are protected here, as are the rankings, which
 * follow the measure shown and open the sessions behind them.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  installIpc,
  modelUsage,
  overview,
  projectUsage,
  sessionPage,
  settle,
  status,
} from "./ipc.ts";

test.beforeEach(async ({ page }) => {
  await installIpc(page);
});

/**
 * Open the overview and answer its reads: the period and the one before it, the
 * rankings, and the top sessions.
 */
async function open(page: Page, answers: { models?: unknown[]; projects?: unknown[] } = {}) {
  await page.goto("/");
  await settle(page, "get_status", status());
  await expect.poll(() => page.evaluate(() => window.__ipc.pendingCount("get_overview"))).toBe(2);
  await settle(page, "get_overview", overview());
  await settle(page, "list_models", answers.models ?? []);
  await settle(page, "list_projects", answers.projects ?? []);
  await settle(page, "list_sessions", sessionPage([]));
}

/** The arguments of the latest call of a command. */
function lastArgs(page: Page, cmd: string) {
  return page.evaluate(
    (c) => window.__ipc.calls.filter((call) => call.cmd === c).at(-1)?.args,
    cmd,
  );
}

test("totals compare with the period before, and unpriced usage shows no cost", async ({
  page,
}) => {
  await open(page);

  const totals = page.locator("dl");
  await expect(totals.getByText("$12.50")).toBeVisible();
  // Both periods were answered alike, so nothing moved.
  await expect(totals.getByText("±0%")).toHaveCount(3);
  const asked = await page.evaluate(() =>
    window.__ipc.calls.filter((call) => call.cmd === "get_overview").map((call) => call.args),
  );
  const [period, before] = asked as { since?: number; until?: number }[];
  expect(before?.until).toBeLessThan(period?.since ?? 0);

  await page.getByRole("button", { name: "Cost", exact: true }).click();
  await settle(page, "list_sessions", sessionPage([]));
  const agents = page.getByRole("list", { name: "Agents" }).getByRole("listitem");
  await expect(agents.filter({ hasText: "Codex" })).toContainText("$12.50");
  await expect(agents.filter({ hasText: "Grok" })).toContainText("—");
});

test("the usage chart has a column for every day and reads out the one chosen", async ({
  page,
}) => {
  await open(page);

  const chart = page.getByRole("slider", { name: "Tokens by day" });
  // Thirty days, today included, whether or not anything was used on them.
  await expect(chart).toHaveAttribute("aria-valuemax", "29");
  await chart.focus();
  await page.keyboard.press("End");
  await expect(chart).toHaveAttribute("aria-valuetext", /: Codex 400K, Grok 100K$/);
  await page.keyboard.press("ArrowLeft");
  await expect(chart).toHaveAttribute("aria-valuetext", /: Codex 2\.0M, Grok 500K$/);
  await page.keyboard.press("ArrowLeft");
  await expect(chart).toHaveAttribute("aria-valuetext", /: no usage$/);

  await page.getByRole("button", { name: "Cost", exact: true }).click();
  await settle(page, "list_sessions", sessionPage([]));
  await expect(page.getByRole("slider", { name: "Cost by day" })).toHaveAttribute(
    "aria-valuetext",
    /: Codex \$10\.00, Grok —$/,
  );
});

test("choosing a column opens the sessions of its day", async ({ page }) => {
  await open(page);

  await page.getByRole("slider", { name: "Tokens by day" }).focus();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  const yesterday = await page.evaluate(() => {
    const day = new Date();
    day.setDate(day.getDate() - 1);
    return [day.getFullYear(), day.getMonth() + 1, day.getDate()]
      .map((part) => String(part).padStart(2, "0"))
      .join("-");
  });
  await expect(page).toHaveURL(new RegExp(`/sessions\\?from=${yesterday}&to=${yesterday}$`));
});

test("rankings order by the measure shown and open the period's sessions", async ({ page }) => {
  await open(page, {
    models: [
      modelUsage("large-and-cheap", 5_000, { costUsd: 1 }),
      modelUsage("small-and-dear", 1_000, { costUsd: 9 }),
    ],
    projects: [projectUsage("/Users/me/Workspace/overwatch", 2_000, 3)],
  });

  const models = page.getByRole("list", { name: "Top models" }).getByRole("link");
  await expect(models.first()).toContainText("large-and-cheap");
  expect(await lastArgs(page, "list_sessions")).toMatchObject({
    filter: { sort: { key: "tokens", descending: true } },
  });

  await page.getByRole("button", { name: "Cost", exact: true }).click();
  // The top sessions are a different five by cost, so they are read again.
  await settle(page, "list_sessions", sessionPage([]));
  expect(await lastArgs(page, "list_sessions")).toMatchObject({
    filter: { sort: { key: "cost", descending: true } },
  });
  await expect(models.first()).toContainText("small-and-dear");

  await page.getByRole("list", { name: "Top projects" }).getByRole("link").click();
  await expect(page).toHaveURL(
    /\/sessions\?period=30&sort=-cost&project=%2FUsers%2Fme%2FWorkspace%2Foverwatch$/,
  );
});
