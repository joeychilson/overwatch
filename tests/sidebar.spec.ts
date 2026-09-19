/**
 * What the sidebar shows from the engine's status.
 *
 * The agents found on this machine are each a way into the session list, the
 * sources a scan had to skip are listed only when there are any, Subscriptions
 * is marked only while a limit needs attention, and a long scan shows how far
 * it has got. All of it comes from the engine alone, so the transport is
 * scripted.
 */
import { expect, test, type Page } from "@playwright/test";
import { lastCopied, recordClipboard } from "./clipboard.ts";
import {
  account,
  engineError,
  installIpc,
  lastArgs,
  session,
  sessionPage,
  settle,
  status,
} from "./ipc.ts";

test.beforeEach(async ({ page }) => {
  await installIpc(page);
});

/** The agents the most recent session read was narrowed to. */
async function sentAgents(page: Page) {
  const args = await lastArgs(page, "list_sessions");
  return (args as { filter: { agents: string[] } }).filter.agents;
}

test("an agent link narrows the session list to that agent", async ({ page }) => {
  await page.goto("/sessions");
  await settle(page, "get_status", status({ agents: ["claude_code", "codex"] }));
  await settle(page, "list_sessions", sessionPage([session("codex:ses_a", "Every agent")]));
  expect(await sentAgents(page)).toEqual([]);

  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const codex = sidebar.getByRole("link", { name: "Codex", exact: true });
  await expect(sidebar.getByRole("link", { name: "Claude Code", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /Skipped sources/ })).toHaveCount(0);

  await codex.click();
  await expect(page).toHaveURL(/\/sessions\?agent=codex$/);
  await settle(
    page,
    "list_sessions",
    sessionPage([session("codex:ses_b", "Parser fix"), session("codex:ses_c", "Docs pass")]),
  );
  expect(await sentAgents(page)).toEqual(["codex"]);
  await expect(page.getByRole("link", { name: /Parser fix/ })).toBeVisible();
  await expect(page.getByText(/2 Codex conversations/)).toBeVisible();
  // The narrowed list is marked on the agent's link, not on Sessions as well.
  await expect(codex).toHaveAttribute("aria-current", "page");
  await expect(page.locator('[aria-current="page"]')).toHaveCount(1);

  await page.getByRole("link", { name: "Show all agents, not only Codex" }).click();
  await expect(page).toHaveURL(/\/sessions$/);
  await settle(page, "list_sessions", sessionPage([session("codex:ses_a", "Every agent")]));
  expect(await sentAgents(page)).toEqual([]);
  await expect(sidebar.getByRole("link", { name: "Sessions", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("an address naming no agent lists every agent rather than failing", async ({ page }) => {
  await page.goto("/sessions?agent=nonexistent");
  await settle(page, "get_status", status());
  await settle(page, "list_sessions", sessionPage([session("codex:ses_a", "Every agent")]));

  // The engine rejects an unknown agent, so it must not be sent.
  expect(await sentAgents(page)).toEqual([]);
  await expect(page.getByRole("link", { name: /Every agent/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sessions", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("sources a scan could not read are listed from the sidebar", async ({ page }) => {
  await page.goto("/");
  await settle(
    page,
    "get_status",
    status({ problems: ["could not read /Users/me/.codex/sessions/broken.jsonl: denied"] }),
  );

  await page.getByRole("button", { name: "Skipped sources", exact: true }).click();
  await expect(page.getByText(/broken\.jsonl: denied/)).toBeVisible();
});

test("a limit running out marks Subscriptions, and one model's used-up limit does not", async ({
  page,
}) => {
  await page.goto("/");
  const weekly = {
    name: "Weekly",
    scope: null,
    resetsAt: 4_102_444_800_000,
    runsOutAt: null,
    perHour: null,
    startsAt: null,
  };
  const pressed = { ...weekly, usedPercent: 60, runsOutAt: Date.now() + 45 * 60_000 };
  // Spark is used up, but only Spark: work carries on with every other model.
  const spark = { ...weekly, scope: "GPT-5.3-Codex-Spark", usedPercent: 100 };
  await settle(page, "get_status", status({ accounts: [account({ limits: [pressed, spark] })] }));

  const subscriptions = page.getByRole("link", { name: /^Subscriptions/ });
  await expect(subscriptions.getByRole("img", { name: "A limit is running out" })).toBeVisible();
});

test("a long scan shows how far it has got", async ({ page }) => {
  await page.goto("/");
  await settle(page, "get_status", status({ scanning: true, progress: [412, 900] }));

  const reading = page.getByRole("progressbar", { name: "Reading history" });
  await expect(reading).toContainText("412 of 900");
  await expect(reading).toHaveAttribute("aria-valuenow", "412");
});

/** Where the app runs once it is installed. */
const INSTALLED = "/Applications/Overwatch.app/Contents/MacOS/overwatch";

test("connecting an agent gives the command that registers this app with it", async ({ page }) => {
  await recordClipboard(page);
  await page.goto("/");
  // Pi has no MCP of its own, so it is passed over.
  await settle(page, "get_status", status({ agents: ["pi", "codex"] }));

  await page.getByRole("button", { name: "Add to your agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Overwatch to your agent" });
  // What to do is said while where the app is is still being found, and stays as it arrives.
  const instruction = dialog.getByRole("heading", { name: "Run this in a terminal" });
  await expect(instruction).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy command" })).toHaveCount(0);
  await settle(page, "get_mcp_server", { command: INSTALLED, args: ["mcp"] });
  await expect(instruction).toBeVisible();

  // The first agent found on this machine is the one offered.
  const agent = dialog.getByRole("group", { name: "Agent" });
  await expect(agent.getByRole("button", { name: "Codex" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dialog.getByRole("button", { name: "Copy command" }).click();
  expect(await lastCopied(page)).toBe(`codex mcp add overwatch -- ${INSTALLED} mcp`);

  await agent.getByRole("button", { name: "Claude Code" }).click();
  await expect(
    dialog.getByText(`claude mcp add --scope user overwatch -- ${INSTALLED} mcp`),
  ).toBeVisible();

  await expect(agent.getByRole("button", { name: "Pi", exact: true })).toHaveCount(0);

  await agent.getByRole("button", { name: "Other" }).click();
  await dialog.getByRole("button", { name: "Copy configuration" }).click();
  expect(JSON.parse((await lastCopied(page)) ?? "")).toEqual({
    mcpServers: { overwatch: { command: INSTALLED, args: ["mcp"] } },
  });

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();

  // Where the app is cannot change while it runs, so opening again asks nothing
  // and shows the steps at once.
  await page.getByRole("button", { name: "Add to your agent" }).click();
  await expect(dialog.getByRole("button", { name: "Copy configuration" })).toBeVisible();
  expect(await page.evaluate(() => window.__ipc.pendingCount("get_mcp_server"))).toBe(0);
});

test("connecting recovers from a failure, and warns when macOS runs a temporary copy", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page, "get_status", status());
  await page.getByRole("button", { name: "Add to your agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Overwatch to your agent" });

  await expect
    .poll(() => page.evaluate(() => window.__ipc.pendingCount("get_mcp_server")))
    .toBeGreaterThan(0);
  await page.evaluate(
    (failure) => window.__ipc.settle("get_mcp_server", "reject", failure),
    engineError("read_failed", "could not read where this app is: denied"),
  );
  await expect(dialog.getByRole("alert")).toHaveText("Could not find where Overwatch is.");
  await expect(dialog.getByText("could not read where this app is: denied")).toBeVisible();

  await dialog.getByRole("button", { name: "Retry" }).click();
  const translocated =
    "/private/var/folders/x1/T/AppTranslocation/0A1B/d/Overwatch.app/Contents/MacOS/overwatch";
  await settle(page, "get_mcp_server", { command: translocated, args: ["mcp"] });
  await expect(dialog.getByRole("alert")).toContainText("temporary copy");
  // With no agent found here, Claude Code is offered.
  await expect(dialog.getByText(`-- ${translocated} mcp`)).toBeVisible();
});
