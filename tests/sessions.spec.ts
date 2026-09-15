/**
 * The session list, over a transport the test settles by hand.
 *
 * What matters here is the asynchronous behaviour the engine's speed does not
 * excuse: the first load versus a later one, a search that changes while an
 * earlier read is still open, pages that accumulate, and the two failures that
 * need different recoveries.
 */
import { expect, test, type Page } from "@playwright/test";
import { engineError, installIpc, session, sessionPage, settle, status } from "./ipc.ts";

test.beforeEach(async ({ page }) => {
  await installIpc(page);
});

test("shows a skeleton first, then the rows", async ({ page }) => {
  await page.goto("/sessions");
  await settle(page, "get_status", status());

  await expect(page.getByText("Reading your conversations…")).toBeVisible();

  await settle(
    page,
    "list_sessions",
    sessionPage([
      session("codex:ses_a", "Fix the parser", { total: 2_625_402, costUsd: 1.5 }),
      session("claude_code:ses_b", "Write the docs", { agent: "claude_code", total: 15_000 }),
    ]),
  );

  await expect(page.getByRole("link", { name: /Fix the parser/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Write the docs/ })).toBeVisible();
  // The description states the totals of the whole match, not the page.
  await expect(page.getByText(/2 conversations/)).toBeVisible();
});

test("the default view hides spawned runs and says which it is showing", async ({ page }) => {
  await page.goto("/sessions");
  await settle(page, "get_status", status());
  await settle(page, "list_sessions", sessionPage([session("codex:ses_a", "A conversation")]));

  const sent = await page.evaluate(
    () => window.__ipc.calls.filter((call) => call.cmd === "list_sessions").at(-1)?.args,
  );
  expect((sent as { filter: { includeSpawned: boolean } }).filter.includeSpawned).toBe(false);

  await page.getByRole("button", { name: "All runs" }).click();
  await settle(
    page,
    "list_sessions",
    sessionPage([
      session("codex:ses_a", "A conversation"),
      session("codex:ses_c", "review", { spawned: true, role: "guardian_review" }),
    ]),
  );

  const after = await page.evaluate(
    () => window.__ipc.calls.filter((call) => call.cmd === "list_sessions").at(-1)?.args,
  );
  expect((after as { filter: { includeSpawned: boolean } }).filter.includeSpawned).toBe(true);
  await expect(page.getByText("agent", { exact: true })).toBeVisible();
});

test("days in the address narrow the list to sessions that used tokens then", async ({ page }) => {
  await page.goto("/sessions?from=2026-09-06&to=2026-09-12");
  await settle(page, "get_status", status());
  await settle(page, "list_sessions", sessionPage([session("codex:ses_a", "That week")]));

  const sent = async () =>
    (
      (await page.evaluate(
        () => window.__ipc.calls.filter((call) => call.cmd === "list_sessions").at(-1)?.args,
      )) as { filter: { since: number | null; until: number | null } }
    ).filter;
  const [first, after] = await page.evaluate(() => [
    new Date(2026, 8, 6).getTime(),
    new Date(2026, 8, 13).getTime(),
  ]);
  expect(await sent()).toMatchObject({ since: first, until: (after ?? 0) - 1 });

  await page.getByRole("link", { name: /^Show every day, not only Sep 6/ }).click();
  await settle(page, "list_sessions", sessionPage([session("codex:ses_a", "That week")]));
  expect(await sent()).toMatchObject({ since: null, until: null });
});

test("choosing a period narrows the list in place of a column's days", async ({ page }) => {
  const rows = sessionPage([session("codex:ses_a", "That week")]);
  await page.goto("/sessions?from=2026-09-06&to=2026-09-12");
  await settle(page, "get_status", status());
  await settle(page, "list_sessions", rows);
  // A column's days are no period, so none is shown chosen.
  await expect(page.getByRole("button", { name: "All time" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await page.getByRole("button", { name: "7 days" }).click();
  await settle(page, "list_sessions", rows);
  await expect(page).toHaveURL(/\/sessions\?period=7$/);
  const sixDaysBack = await page.evaluate(() => {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - 6);
    return day.getTime();
  });
  expect(await lastFilter(page)).toMatchObject({ since: sixDaysBack, until: null });
});

test("a session missing from its source is marked but still listed", async ({ page }) => {
  await page.goto("/sessions");
  await settle(page, "get_status", status());
  await settle(
    page,
    "list_sessions",
    sessionPage([session("codex:ses_a", "Gone upstream", { present: false })]),
  );

  await expect(page.getByRole("link", { name: /Gone upstream/ })).toBeVisible();
  await expect(
    page.getByLabel("No longer in its source; the history read so far is kept"),
  ).toBeVisible();
});

test("a session with no recorded usage reads as unknown, not zero", async ({ page }) => {
  await page.goto("/sessions");
  await settle(page, "get_status", status());
  await settle(
    page,
    "list_sessions",
    sessionPage([session("codex:ses_a", "Nothing recorded", { total: 0 })]),
  );

  const row = page.getByRole("listitem").filter({ hasText: "Nothing recorded" });
  await expect(row.getByTitle("No usage was recorded")).toBeVisible();
});

test("a later search supersedes an earlier one", async ({ page }) => {
  await page.goto("/sessions");
  await settle(page, "get_status", status());
  await settle(page, "list_sessions", sessionPage([session("codex:ses_a", "First result")]));

  await page.getByLabel("Search sessions").fill("parser");
  await expect.poll(() => page.evaluate(() => window.__ipc.pendingCount("list_sessions"))).toBe(1);

  await page.getByLabel("Search sessions").fill("docs");
  await expect.poll(() => page.evaluate(() => window.__ipc.pendingCount("list_sessions"))).toBe(2);

  // Settling both at once resolves the older read last in insertion order;
  // the newer result must still be the one on screen.
  await page.evaluate(
    (data) => window.__ipc.settle("list_sessions", "resolve", data),
    sessionPage([session("codex:ses_d", "Docs result")]),
  );

  await expect(page.getByRole("link", { name: /Docs result/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /First result/ })).toBeHidden();
  const sent = await page.evaluate(
    () => window.__ipc.calls.filter((call) => call.cmd === "list_sessions").at(-1)?.args,
  );
  expect((sent as { filter: { search: string } }).filter.search).toBe("docs");
});

test("a failed first read offers a retry that recovers", async ({ page }) => {
  await page.goto("/sessions");
  await settle(page, "get_status", status());

  await expect
    .poll(() => page.evaluate(() => window.__ipc.pendingCount("list_sessions")))
    .toBeGreaterThan(0);
  await page.evaluate(
    (failure) => window.__ipc.settle("list_sessions", "reject", failure),
    engineError("store_failed", "the index database failed"),
  );

  await expect(page.getByRole("alert")).toHaveText("Could not load sessions.");
  await expect(page.getByText("the index database failed")).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).click();
  await settle(page, "list_sessions", sessionPage([session("codex:ses_a", "Recovered")]));
  await expect(page.getByRole("link", { name: /Recovered/ })).toBeVisible();
});

test("sorting asks the engine for the new ordering", async ({ page }) => {
  await page.goto("/sessions");
  await settle(page, "get_status", status());
  await settle(page, "list_sessions", sessionPage([session("codex:ses_a", "A conversation")]));

  await page.getByRole("button", { name: "Sort by Tokens" }).click();
  await settle(page, "list_sessions", sessionPage([session("codex:ses_a", "A conversation")]));

  const sent = await page.evaluate(
    () => window.__ipc.calls.filter((call) => call.cmd === "list_sessions").at(-1)?.args,
  );
  const sort = (sent as { filter: { sort: { key: string; descending: boolean } } }).filter.sort;
  // Size reads largest first when a reader asks for it.
  expect(sort).toEqual({ key: "tokens", descending: true });

  await page.getByRole("button", { name: "Sort by Tokens" }).click();
  await settle(page, "list_sessions", sessionPage([session("codex:ses_a", "A conversation")]));
  const again = await page.evaluate(
    () => window.__ipc.calls.filter((call) => call.cmd === "list_sessions").at(-1)?.args,
  );
  expect((again as { filter: { sort: { descending: boolean } } }).filter.sort.descending).toBe(
    false,
  );
});

/** The filter the list last asked the engine for. */
async function lastFilter(page: Page) {
  const args = await page.evaluate(
    () => window.__ipc.calls.filter((call) => call.cmd === "list_sessions").at(-1)?.args,
  );
  return (args as { filter: Record<string, unknown> }).filter;
}

test("what the list shows lives in its address, so coming back finds it as left", async ({
  page,
}) => {
  const rows = sessionPage([session("codex:ses_a", "Fix the parser")]);
  await page.goto("/sessions");
  await settle(page, "get_status", status());
  await settle(page, "list_sessions", rows);

  await page.getByLabel("Search sessions").fill("parser");
  await settle(page, "list_sessions", rows);
  await page.getByRole("button", { name: "Sort by Tokens" }).click();
  await settle(page, "list_sessions", rows);
  await expect(page).toHaveURL(/\/sessions\?q=parser&sort=-tokens$/);

  await page.getByRole("link", { name: "Fix the parser" }).click();
  await expect(page).toHaveURL(/\/sessions\/codex:ses_a$/);
  const reads = await page.evaluate(
    () => window.__ipc.calls.filter((call) => call.cmd === "list_sessions").length,
  );
  await page.getByRole("link", { name: "Back to sessions" }).click();

  await expect(page).toHaveURL(/\/sessions\?q=parser&sort=-tokens$/);
  await expect(page.getByLabel("Search sessions")).toHaveValue("parser");
  // The rows are there at once, with nothing read again to show them.
  await expect(page.getByRole("link", { name: "Fix the parser" })).toBeVisible();
  expect(
    await page.evaluate(
      () => window.__ipc.calls.filter((call) => call.cmd === "list_sessions").length,
    ),
  ).toBe(reads);
});

test("a row's project or model narrows the list to the sessions that share it", async ({
  page,
}) => {
  const rows = sessionPage([session("codex:ses_a", "Fix the parser")]);
  await page.goto("/sessions");
  await settle(page, "get_status", status());
  await settle(page, "list_sessions", rows);

  await page.getByRole("link", { name: "demo", exact: true }).click();
  await settle(page, "list_sessions", rows);
  expect((await lastFilter(page)).project).toBe("/Users/me/Workspace/demo");

  await page.getByRole("link", { name: "gpt-5-codex", exact: true }).click();
  await settle(page, "list_sessions", rows);
  expect(await lastFilter(page)).toMatchObject({
    project: "/Users/me/Workspace/demo",
    model: "gpt-5-codex",
  });

  await page.getByRole("link", { name: "Show every project, not only demo" }).click();
  await settle(page, "list_sessions", rows);
  expect((await lastFilter(page)).project).toBeNull();
});

test("a model in the address narrows the list to the sessions that used it", async ({ page }) => {
  await page.goto("/sessions?model=gpt-5-codex");
  await settle(page, "get_status", status());
  await settle(page, "list_sessions", sessionPage([session("codex:ses_a", "Fix the parser")]));

  expect((await lastFilter(page)).model).toBe("gpt-5-codex");
  await expect(
    page.getByRole("link", { name: "Show every model, not only gpt-5-codex" }),
  ).toBeVisible();
});

test("changing the ordering and back keeps the list on screen", async ({ page }) => {
  const long = new Date(2020, 0, 15).getTime();
  // In title order, so that last activity would not put them in a row.
  const rows = sessionPage([
    session("codex:ses_a", "A while back", { updatedAt: long }),
    session("codex:ses_b", "Just started", { updatedAt: Date.now() }),
    session("codex:ses_c", "Zebra", { updatedAt: long }),
  ]);
  await page.goto("/sessions");
  await settle(page, "get_status", status());
  await settle(page, "list_sessions", rows);

  // Each ordering is shown before its rows arrive, over the rows of the last.
  await page.getByRole("button", { name: "Sort by Session" }).click();
  await page.getByRole("button", { name: "Sort by Last activity" }).click();
  await expect(page.getByRole("link", { name: "Zebra" })).toBeVisible();
  await settle(page, "list_sessions", rows);

  await expect(page.getByRole("link", { name: "A while back" })).toBeVisible();
  // Still going, so it says so.
  await expect(page.getByRole("listitem").filter({ hasText: "Just started" })).toContainText("Now");
});

test("an empty result explains itself", async ({ page }) => {
  await page.goto("/sessions");
  await settle(page, "get_status", status());
  await settle(page, "list_sessions", sessionPage([], { total: 0 }));

  await expect(page.getByText("No sessions match.")).toBeVisible();
  await expect(page.getByText("No conversations have been indexed yet.")).toBeVisible();

  await page.getByLabel("Search sessions").fill("nothing matches this");
  await settle(page, "list_sessions", sessionPage([], { total: 0 }));
  await expect(page.getByText("Try a different search.")).toBeVisible();
});
