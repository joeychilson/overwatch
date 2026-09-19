/**
 * The panel the menu bar item drops down.
 *
 * The menu bar's figure follows the subscriptions in use, so the panel must put
 * those first, set them apart, and open them, and its ways out must reach the
 * engine: they are the only ones while the app is out of the Dock.
 */
import { expect, test } from "@playwright/test";
import { account, emitTo, installIpc, lastArgs, overview, settle, status } from "./ipc.ts";

test.beforeEach(async ({ page }) => {
  await installIpc(page);
});

/** A limit on all usage that no test run sees reset. */
const nearlyOut = {
  name: "5 hours",
  scope: null,
  usedPercent: 95,
  resetsAt: 4_102_444_800_000,
  runsOutAt: null,
  perHour: null,
  startsAt: null,
};

test("the subscriptions in use come first and open, however near a limit the others are", async ({
  page,
}) => {
  await page.goto("/tray");
  const idle = account({ id: "claude:", provider: "claude", label: null, limits: [nearlyOut] });
  const working = account({ usedAt: Date.now() - 5 * 60_000 });
  await settle(page, "get_status", status({ accounts: [idle, working] }));

  await expect(page.getByRole("heading", { level: 3 })).toHaveText([/Codex/, /Claude/]);
  const inUse = page.getByRole("region", { name: "In use" });
  const codex = inUse.getByRole("region", { name: "Codex joey@example.com" });
  await expect(codex.getByRole("button", { expanded: true })).toBeVisible();
  await expect(codex.getByText("58% left")).toBeVisible();

  // The one not in use stands on one line with what its tightest limit has left.
  const claude = page.getByRole("region", { name: "Not in use" }).getByRole("region");
  const header = claude.getByRole("button", { name: /^Claude/ });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(header).toContainText("5% left");
  await expect(claude.getByRole("listitem")).toBeHidden();
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(claude.getByRole("listitem")).toContainText("5 hours");

  // The panel is a window of its own, without the app's sidebar.
  await expect(page.getByRole("link", { name: /^Subscriptions/ })).toHaveCount(0);
});

test("with nothing in use, the subscription used last comes first and open", async ({ page }) => {
  await page.goto("/tray");
  const never = account({ id: "claude:", provider: "claude", label: null, limits: [nearlyOut] });
  const last = account({ usedAt: Date.now() - 2 * 60 * 60_000 });
  await settle(page, "get_status", status({ accounts: [never, last] }));

  await expect(page.getByRole("heading", { level: 3 })).toHaveText([/Codex/, /Claude/]);
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Codex/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByRole("button", { name: /^Claude/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("an account with no limits read yet has nothing to open", async ({ page }) => {
  await page.goto("/tray");
  const unread = account({ id: "grok:", provider: "grok", limits: [], problem: "sign_in" });
  await settle(page, "get_status", status({ accounts: [unread, account()] }));

  const grok = page.getByRole("region", { name: "Grok joey@example.com" });
  await expect(grok.getByRole("heading", { level: 3 })).toHaveText(/Grok/);
  await expect(grok).toContainText("to renew the sign-in");
  await expect(grok.getByRole("button")).toHaveCount(0);
});

test("an account with no limit read yet has nothing to open, and stands last", async ({ page }) => {
  await page.goto("/tray");
  const unread = account({ id: "grok:", provider: "grok", limits: [], problem: "sign_in" });
  await settle(page, "get_status", status({ accounts: [unread, account()] }));

  await expect(page.getByRole("heading", { level: 3 })).toHaveText([/Codex/, /Grok/]);
  const grok = page.getByRole("region", { name: "Grok joey@example.com" });
  await expect(grok).toContainText("to renew the sign-in");
  await expect(grok).not.toContainText("Last read");
  await expect(grok.getByRole("button")).toHaveCount(0);
});

test("limits that can no longer be read are kept, with how old they are", async ({ page }) => {
  await page.goto("/tray");
  const lapsed = account({ problem: "sign_in", readAt: Date.now() - 2 * 24 * 60 * 60_000 });
  await settle(page, "get_status", status({ accounts: [lapsed] }));

  const codex = page.getByRole("region", { name: "Codex joey@example.com" });
  await expect(codex).toContainText("to renew the sign-in. Last read 2 days ago.");
  await expect(codex.getByRole("button", { expanded: true })).toBeVisible();
  await expect(codex.getByText("58% left")).toBeVisible();
});

test("an account opened by hand is closed again once the panel is put away", async ({ page }) => {
  await page.goto("/tray");
  const idle = account({ id: "claude:", provider: "claude", label: null, limits: [nearlyOut] });
  const working = account({ usedAt: Date.now() - 5 * 60_000 });
  await settle(page, "get_status", status({ accounts: [idle, working] }));

  const claude = page.getByRole("button", { name: /^Claude/ });
  const codex = page.getByRole("button", { name: /^Codex/ });
  await claude.click();
  await codex.click();
  await expect(claude).toHaveAttribute("aria-expanded", "true");
  await expect(codex).toHaveAttribute("aria-expanded", "false");

  // The engine hides the panel once it loses focus.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(claude).toHaveAttribute("aria-expanded", "false");
  await expect(codex).toHaveAttribute("aria-expanded", "true");
});

test("a long account name is cut short rather than widening the panel", async ({ page }) => {
  // The window is as wide as the panel, so anything wider is cut off at its edge.
  await page.setViewportSize({ width: 340, height: 600 });
  await page.goto("/tray");
  const label = "someone-with-a-long-name@privaterelay.appleid.com";
  const used = { ...nearlyOut, usedPercent: 100 };
  await settle(page, "get_status", status({ accounts: [account({ label, limits: [used] })] }));

  const header = page.getByRole("button", { name: /^Codex/ });
  await header.click();
  await expect(header).toContainText("Limit reached");
  const edges = await page
    .locator("[data-row]")
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().right));
  expect(Math.max(...edges)).toBeLessThanOrEqual(340);
});

test("the panel opens the window and quits the app", async ({ page }) => {
  await page.goto("/tray");
  await settle(page, "get_status", status());
  await expect(page.getByText("No subscriptions found")).toBeVisible();

  await page.getByRole("button", { name: "Open Overwatch" }).click();
  await page.getByRole("button", { name: "Quit Overwatch" }).click();
  const commands = await page.evaluate(() => window.__ipc.calls.map((call) => call.cmd));
  expect(commands).toEqual(expect.arrayContaining(["open_window", "quit"]));
});

test("the panel answers the keys a menu does", async ({ page }) => {
  await page.goto("/tray");
  await settle(page, "get_status", status({ accounts: [account()] }));
  const called = (cmd: string) =>
    page.evaluate((c) => window.__ipc.calls.filter((call) => call.cmd === c).length, cmd);

  // The arrows move through the rows and wrap round, and Return chooses one.
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("button", { name: "Quit Overwatch" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: /^Today/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const codex = page.getByRole("button", { name: /^Codex/ });
  await expect(codex).toBeFocused();
  await expect(codex).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(codex).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("Meta+KeyO");
  await expect.poll(() => called("open_window")).toBe(1);
  expect(await lastArgs(page, "open_window")).toEqual({});
  await page.keyboard.press("Meta+KeyQ");
  await expect.poll(() => called("quit")).toBe(1);
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
