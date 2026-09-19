/**
 * The Models page. A model with no listed price must read as unpriced, never
 * as free.
 */
import { expect, test } from "@playwright/test";
import { engineError, installIpc, lastArgs, modelUsage, settle, status } from "./ipc.ts";

test.beforeEach(async ({ page }) => {
  await installIpc(page);
});

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

  const sent = await lastArgs(page, "list_models");
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
