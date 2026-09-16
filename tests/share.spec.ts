/**
 * The share card.
 *
 * The card is drawn by hand into a canvas and then leaves the app, so what is
 * protected here is that it is only offered once there is something to draw,
 * that what leaves is a PNG named for the period it covers, and that a save
 * that fails says so rather than reading as done.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  engineError,
  installIpc,
  modelUsage,
  overview,
  projectUsage,
  sessionPage,
  settle,
  status,
} from "./ipc.ts";

const MODELS = [
  modelUsage("claude-opus-5", 2_000_000, { costUsd: 20, agents: ["claude_code"] }),
  modelUsage("gpt-5-codex", 1_000_000, { costUsd: 4, agents: ["codex"] }),
];

test.beforeEach(async ({ page }) => {
  await installIpc(page);
});

/** Open the overview and answer every read the header depends on. */
async function open(page: Page) {
  await page.goto("/");
  await settle(page, "get_status", status());
  await expect.poll(() => page.evaluate(() => window.__ipc.pendingCount("get_overview"))).toBe(2);
  await settle(page, "get_overview", overview());
  await settle(page, "list_models", MODELS);
  await settle(page, "list_projects", [projectUsage("/Users/me/Workspace/demo", 3_000_000)]);
  await settle(page, "list_sessions", sessionPage([]));
}

/** Today as the card names it in a file, which is the reader's own day. */
function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${String(now.getDate()).padStart(2, "0")}`;
}

test("nothing is offered to share until the period has been read", async ({ page }) => {
  await page.goto("/");
  await settle(page, "get_status", status());
  const share = page.getByRole("button", { name: "Share this period" });
  await expect(share).toBeDisabled();

  await expect.poll(() => page.evaluate(() => window.__ipc.pendingCount("get_overview"))).toBe(2);
  await settle(page, "get_overview", overview());
  await settle(page, "list_models", MODELS);
  await settle(page, "list_projects", []);
  await settle(page, "list_sessions", sessionPage([]));
  await expect(share).toBeEnabled();
});

test("the card names the period, and saving sends a PNG named for it", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Share this period" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Last 30 days", { exact: false })).toBeVisible();
  // The drawing itself is passed over, so its frame carries what it says.
  await expect(dialog.getByRole("img")).toHaveAccessibleName(/Last 30 days\./);
  await expect(dialog.getByRole("img")).toHaveAccessibleName(/claude-opus-5 did 67% of the work\./);

  await dialog.getByRole("button", { name: "Save to Desktop" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ipc.pendingCount("save_card")))
    .toBeGreaterThan(0);
  const args = (await page.evaluate(
    () => window.__ipc.calls.filter((call) => call.cmd === "save_card").at(-1)?.args,
  )) as { name: string; png: string };
  expect(args.name).toBe(`overwatch-30-days-${today()}`);
  // A PNG's signature, base64: what the engine refuses anything else in place of.
  expect(args.png.startsWith("iVBORw0KGgo")).toBe(true);

  await settle(page, "save_card", "/Users/me/Desktop/overwatch-30-days.png");
  await expect(dialog.getByText("Saved · Desktop/overwatch-30-days.png")).toBeVisible();
});

test("the palette the card is drawn in is the reader's to choose", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Share this period" }).click();

  const dialog = page.getByRole("dialog");
  const light = dialog.getByRole("button", { name: "Light", exact: true });
  await expect(light).toHaveAttribute("aria-pressed", "true");

  await dialog.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(light).toHaveAttribute("aria-pressed", "false");

  // The two palettes draw two different pictures of the same period.
  const dark = await page.evaluate(
    () => document.querySelector("canvas")?.toDataURL("image/png") ?? "",
  );
  await light.click();
  const pale = await page.evaluate(
    () => document.querySelector("canvas")?.toDataURL("image/png") ?? "",
  );
  expect(pale).not.toBe(dark);
});

test("a save that fails says so, and leaves the card to try again", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Share this period" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Save to Desktop" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ipc.pendingCount("save_card")))
    .toBeGreaterThan(0);
  await page.evaluate(
    (error) => window.__ipc.settle("save_card", "reject", error),
    engineError("write_failed", "could not write /Users/me/Desktop: permission denied"),
  );

  await expect(
    dialog.getByText("could not write /Users/me/Desktop: permission denied"),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save to Desktop" })).toBeEnabled();
});

test("what the last save said is not carried into the next one", async ({ page }) => {
  await open(page);
  const share = page.getByRole("button", { name: "Share this period" });
  const dialog = page.getByRole("dialog");

  await share.click();
  await dialog.getByRole("button", { name: "Save to Desktop" }).click();
  await settle(page, "save_card", "/Users/me/Desktop/overwatch-30-days.png");
  await expect(dialog.getByText("Saved · Desktop/overwatch-30-days.png")).toBeVisible();

  await dialog.getByRole("button", { name: "Close" }).click();
  await share.click();
  await expect(dialog.getByText("Saved", { exact: false })).toBeHidden();
});

/** The engine's own refusal reaches the dialog unchanged. */
test("a card the engine refuses is reported in its own words", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Share this period" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Save to Desktop" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ipc.pendingCount("save_card")))
    .toBeGreaterThan(0);
  await page.evaluate(
    (error) => window.__ipc.settle("save_card", "reject", error),
    engineError("invalid", "the card is not a PNG"),
  );
  await expect(dialog.getByText("the card is not a PNG")).toBeVisible();
});
