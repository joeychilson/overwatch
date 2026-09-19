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
  tokens,
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

test("today is drawn by the hour, and an hour opens the sessions of it", async ({ page }) => {
  await page.goto("/?period=today");
  await settle(page, "get_status", status());
  const [midnight, nine] = await page.evaluate(() => {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    // Hours are elapsed time from midnight, which a clock change does not move.
    return [day.getTime(), day.getTime() + 9 * 3_600_000];
  });
  await expect.poll(() => page.evaluate(() => window.__ipc.pendingCount("get_overview"))).toBe(2);
  await settle(page, "get_overview", overview());
  await settle(page, "list_models", []);
  await settle(page, "list_projects", []);
  await settle(page, "list_hours", [
    {
      hour: nine,
      sessions: 1,
      tokens: tokens(300_000),
      costUsd: 2,
      byAgent: [{ agent: "codex", tokens: 300_000, costUsd: 2 }],
    },
  ]);
  await settle(page, "list_sessions", sessionPage([]));

  expect(await lastArgs(page, "list_hours")).toMatchObject({ since: midnight });
  // Today is compared with yesterday up to the same time, not all of it.
  const [, before] = (await page.evaluate(() =>
    window.__ipc.calls.filter((call) => call.cmd === "get_overview").map((call) => call.args),
  )) as { since?: number; until?: number }[];
  expect(before?.until).toBeLessThan(midnight);
  expect(before?.until).toBeGreaterThan(midnight - 24 * 3_600_000);

  const chart = page.getByRole("slider", { name: "Tokens by hour" });
  await chart.focus();
  await page.keyboard.press("Home");
  for (let hour = 0; hour < 9; hour += 1) await page.keyboard.press("ArrowRight");
  await expect(chart).toHaveAttribute("aria-valuetext", /: Codex 300K$/);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(new RegExp(`/sessions\\?hour=${nine}$`));
  await settle(page, "list_sessions", sessionPage([]));
  expect(await lastArgs(page, "list_sessions")).toMatchObject({
    filter: { since: nine, until: nine + 3_600_000 - 1 },
  });
  await expect(page.getByRole("link", { name: /^Show every hour, not only / })).toBeVisible();
  // An hour is no period, so none is shown chosen.
  await expect(page.getByRole("button", { name: "Today" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
