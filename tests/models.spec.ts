/**
 * The models view and the subscriptions view.
 *
 * Both show figures that can be missing — a model with no listed price, a limit
 * that could not be read — so the behaviour worth protecting is that an absent
 * or stale figure stays visibly so, rather than being shown as a zero or as
 * current.
 */
import { expect, test } from "@playwright/test";
import { account, engineError, installIpc, modelUsage, settle, status } from "./ipc.ts";

test.beforeEach(async ({ page }) => {
  await installIpc(page);
});

/** A limit covering all usage, resetting far enough ahead that no run sees it end. */
function limit(usedPercent: number, scope: string | null = null) {
  return { name: "Weekly", scope, usedPercent, resetsAt: 4_102_444_800_000, runsOutAt: null };
}

test("models rank by recorded usage", async ({ page }) => {
  await page.goto("/models");
  await settle(page, "get_status", status());
  await settle(page, "list_models", [
    modelUsage("claude-opus-5", 2_525_916_713, {
      sessions: 34,
      costUsd: 1560.89,
      agents: ["claude_code"],
    }),
    modelUsage("gpt-5-codex", 346_726_436, { sessions: 342 }),
  ]);

  await expect(page.getByText("claude-opus-5")).toBeVisible();
  // The summary line and the row both state it; the row is the ranking.
  await expect(page.getByRole("list", { name: "Models" }).getByText("$1,560.89")).toBeVisible();
  await expect(page.getByText("2 models", { exact: false })).toBeVisible();
});

test("a model with no listed price shows no cost rather than zero", async ({ page }) => {
  await page.goto("/models");
  await settle(page, "get_status", status());
  await settle(page, "list_models", [modelUsage("codex-auto-review", 346_726_436)]);

  // Presenting unpriced usage as $0.00 would say it was free.
  await expect(page.getByTitle("No price is listed for this model")).toHaveText("—");
});

test("changing the period asks the engine for a new window", async ({ page }) => {
  await page.goto("/models");
  await settle(page, "get_status", status());
  await settle(page, "list_models", [modelUsage("gpt-5-codex", 1_000)]);

  await page.getByRole("button", { name: "All time" }).click();
  await settle(page, "list_models", [modelUsage("gpt-5-codex", 2_000)]);

  const sent = await page.evaluate(
    () => window.__ipc.calls.filter((call) => call.cmd === "list_models").at(-1)?.args,
  );
  // All time is an unbounded read: no start is sent at all.
  expect((sent as { since?: number }).since).toBeUndefined();
});

test("a model opens the sessions that used it in the period shown", async ({ page }) => {
  await page.goto("/models");
  await settle(page, "get_status", status());
  await settle(page, "list_models", [modelUsage("claude-opus-5", 2_000)]);

  await page.getByRole("link", { name: /claude-opus-5/ }).click();
  await expect(page).toHaveURL(/\/sessions\?period=30&model=claude-opus-5$/);
});

test("models rank by cost when asked, and the ranking is kept in the address", async ({ page }) => {
  await page.goto("/models");
  await settle(page, "get_status", status());
  await settle(page, "list_models", [
    modelUsage("large-and-cheap", 5_000, { costUsd: 1 }),
    modelUsage("small-and-dear", 1_000, { costUsd: 9 }),
  ]);

  const rows = page.getByRole("list", { name: "Models" }).getByRole("link");
  await expect(rows.first()).toContainText("large-and-cheap");
  await page.getByRole("button", { name: "Sort by Cost" }).click();
  await expect(rows.first()).toContainText("small-and-dear");
  await expect(page).toHaveURL(/\/models\?sort=-cost$/);
});

test("a failed ranking offers a retry", async ({ page }) => {
  await page.goto("/models");
  await settle(page, "get_status", status());
  await expect
    .poll(() => page.evaluate(() => window.__ipc.pendingCount("list_models")))
    .toBeGreaterThan(0);
  await page.evaluate(
    (failure) => window.__ipc.settle("list_models", "reject", failure),
    engineError("store_failed", "the index database failed"),
  );

  await expect(page.getByRole("alert")).toHaveText("Could not read model usage.");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("an account shows what is left of each limit, who holds it, and when it was read", async ({
  page,
}) => {
  await page.goto("/subscriptions");
  await settle(page, "get_status", status({ accounts: [account()] }));

  const codex = page.getByRole("region", { name: "Codex joey@example.com" });
  await expect(codex.getByRole("heading", { name: "Codex" })).toBeVisible();
  await expect(codex.getByText("pro")).toBeVisible();
  await expect(codex.getByText("58% left")).toBeVisible();
  await expect(codex.getByText("44% left")).toBeVisible();
  // The reading's age is stated, because a stale percentage shown as live
  // would be worse than showing none.
  await expect(codex.getByText(/^Updated /)).toHaveAttribute(
    "title",
    /^Signed in with Codex and Pi/,
  );
});

test("two accounts of one subscription are each shown", async ({ page }) => {
  await page.goto("/subscriptions");
  const work = account({ id: "codex:workspace-2", label: "work@example.com", via: ["OpenCode"] });
  await settle(page, "get_status", status({ accounts: [account(), work] }));

  await expect(page.getByRole("region", { name: "Codex joey@example.com" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Codex work@example.com" })).toBeVisible();
});

test("a failed refresh keeps the last limits and says how to fix it", async ({ page }) => {
  await page.goto("/subscriptions");
  await settle(page, "get_status", status({ accounts: [account({ problem: "sign_in" })] }));

  await expect(page.getByText("Open Codex or Pi to renew the sign-in.")).toBeVisible();
  await expect(page.getByText("58% left")).toBeVisible();
});

test("a used-up limit says when it is back rather than showing a percentage", async ({ page }) => {
  await page.goto("/subscriptions");
  const spent = { ...limit(100), resetsAt: Date.now() + 72 * 60_000 };
  await settle(page, "get_status", status({ accounts: [account({ limits: [spent] })] }));

  await expect(page.getByText("Limit reached")).toBeVisible();
  await expect(page.getByText(/^Back in /)).toBeVisible();
  await expect(page.getByText("0% left")).toHaveCount(0);
});

test("a limit whose window has ended reads as full again, not as its old figure", async ({
  page,
}) => {
  await page.goto("/subscriptions");
  const ended = { ...limit(85), resetsAt: 1_789_000_000_000 };
  await settle(page, "get_status", status({ accounts: [account({ limits: [ended] })] }));

  await expect(page.getByText("Full again")).toBeVisible();
  await expect(page.getByText("15% left")).toHaveCount(0);
});

test("the account nearest a limit comes first, unless only one model's limit is near", async ({
  page,
}) => {
  await page.goto("/subscriptions");
  const accounts = [
    account({ id: "claude:", provider: "claude", label: null, limits: [limit(20)] }),
    // Spark is used up, but only Spark: the account can still be worked in.
    account({ id: "codex:a", limits: [limit(10), limit(100, "GPT-5.3-Codex-Spark")] }),
    account({ id: "grok:b", provider: "grok", label: null, limits: [limit(95)] }),
  ];
  await settle(page, "get_status", status({ accounts }));

  const cards = page.getByRole("main").getByRole("heading", { level: 2 });
  await expect(cards).toHaveText(["Grok", "Claude", "Codex"]);
});

test("a limit on pace to run out before it resets says when", async ({ page }) => {
  await page.goto("/subscriptions");
  const pressed = { ...limit(60), runsOutAt: Date.now() + 45 * 60_000 };
  await settle(page, "get_status", status({ accounts: [account({ limits: [pressed] })] }));

  await expect(page.getByText(/^Runs out in /)).toBeVisible();
});

test("no subscriptions explains where limits come from", async ({ page }) => {
  await page.goto("/subscriptions");
  await settle(page, "get_status", status());

  await expect(page.getByText("No subscriptions found.")).toBeVisible();
  await expect(page.getByText(/^Overwatch reads/)).toBeVisible();
});
