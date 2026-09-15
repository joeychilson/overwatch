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
import { account, installIpc, session, sessionPage, settle, status } from "./ipc.ts";

test.beforeEach(async ({ page }) => {
  await installIpc(page);
});

/** The agents the most recent session read was narrowed to. */
async function sentAgents(page: Page) {
  const args = await page.evaluate(
    () => window.__ipc.calls.filter((call) => call.cmd === "list_sessions").at(-1)?.args,
  );
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
  const weekly = { name: "Weekly", scope: null, resetsAt: 4_102_444_800_000, runsOutAt: null };
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
