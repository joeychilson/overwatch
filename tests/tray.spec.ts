/**
 * The panel the menu bar item drops down.
 *
 * The menu bar's figure follows the subscriptions in use, so the panel must put
 * those first and set them apart, and its ways out must reach the engine.
 */
import { expect, test } from "@playwright/test";
import { account, emitTo, installIpc, lastArgs, overview, settle, status } from "./ipc.ts";

test.beforeEach(async ({ page }) => {
  await installIpc(page);
});

test("the subscriptions in use come first, however near a limit the others are", async ({
  page,
}) => {
  await page.goto("/tray");
  const nearlyOut = { name: "5 hours", scope: null, usedPercent: 95, resetsAt: 4_102_444_800_000 };
  const idle = account({
    id: "claude:",
    provider: "claude",
    label: null,
    limits: [{ ...nearlyOut, runsOutAt: null }],
  });
  const working = account({ usedAt: Date.now() - 5 * 60_000 });
  await settle(page, "get_status", status({ accounts: [idle, working] }));

  await expect(page.getByRole("heading", { level: 3 })).toHaveText(["Codex", "Claude"]);
  const inUse = page.getByRole("region", { name: "In use" });
  await expect(inUse.getByRole("region", { name: "Codex joey@example.com" })).toBeVisible();
  await expect(inUse.getByText("58% left")).toBeVisible();
  await expect(page.getByRole("region", { name: "Not in use" })).toContainText("Claude");
  // The panel is a window of its own, without the app's sidebar.
  await expect(page.getByRole("link", { name: /^Subscriptions/ })).toHaveCount(0);
});

test("with nothing in use the subscriptions stand unlabelled", async ({ page }) => {
  await page.goto("/tray");
  await settle(page, "get_status", status({ accounts: [account()] }));

  await expect(page.getByRole("heading", { level: 3 })).toHaveText(["Codex"]);
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
});

test("the panel opens the window and quits the app", async ({ page }) => {
  await page.goto("/tray");
  await settle(page, "get_status", status());
  await expect(page.getByText("No subscriptions found.")).toBeVisible();

  await page.getByRole("button", { name: "Open Overwatch" }).click();
  await page.getByRole("button", { name: "Quit Overwatch" }).click();
  const commands = await page.evaluate(() => window.__ipc.calls.map((call) => call.cmd));
  expect(commands).toEqual(expect.arrayContaining(["open_window", "quit"]));
});

test("a destination the app's menu sends its window leaves the panel where it is", async ({
  page,
}) => {
  await page.goto("/tray");
  await settle(page, "get_status", status({ accounts: [account()] }));

  // The panel runs the app's root layout, which listens for destinations.
  expect(await emitTo(page, "main", "open", "/sessions")).toBe(0);
  await expect(page).toHaveURL(/\/tray$/);
  await expect(page.getByRole("button", { name: "Open Overwatch" })).toBeVisible();
});

test("what today has used so far opens the overview of today", async ({ page }) => {
  await page.goto("/tray");
  await settle(page, "get_status", status({ accounts: [account()] }));
  await settle(page, "get_overview", overview());

  const midnight = await page.evaluate(() => new Date().setHours(0, 0, 0, 0));
  const asked = await lastArgs(page, "get_overview");
  expect(asked).toMatchObject({ since: midnight });

  const today = page.getByRole("button", { name: /^Today/ });
  await expect(today).toContainText("3.0M tokens · $12.50");
  await today.click();
  const opened = await lastArgs(page, "open_window");
  expect(opened).toEqual({ path: "/?period=today" });
});
