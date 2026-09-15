/**
 * Reading one session.
 *
 * The engine delivers turns with their text and tool results already attached,
 * so what is worth testing here is how each kind of turn reads, that a long
 * conversation pages, that the timeline can bring any turn into view, and that
 * a failure part-way through keeps what was already on screen.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  engineError,
  installIpc,
  marks,
  session,
  settle,
  status,
  transcript,
  turn,
} from "./ipc.ts";

test.beforeEach(async ({ page }) => {
  await installIpc(page);
});

type Turns = ReturnType<typeof turn>[];

/** Open a session and answer its reads: the session, its timeline, and its first page. */
async function openSession(
  page: Page,
  turns: Turns,
  options: { total?: number; timeline?: Turns } = {},
) {
  await page.goto("/sessions/codex:ses_a");
  await settle(page, "get_status", status());
  await settle(
    page,
    "get_session",
    session("codex:ses_a", "Fix the parser", { total: 2_625_402, costUsd: 1.5 }),
  );
  await settle(page, "get_timeline", marks(options.timeline ?? turns));
  await settle(page, "get_transcript", transcript(turns, { total: options.total }));
}

test("the header shows what the engine established and how to pick it up", async ({ page }) => {
  await openSession(page, [
    turn(0, "user", "Fix the parser"),
    turn(1, "tool", "", { name: "exec", input: "pwd", output: "/w" }),
    turn(2, "assistant", "Fixed."),
  ]);

  await expect(page.getByRole("heading", { name: "Fix the parser" })).toBeVisible();
  const figures = page.getByRole("definition");
  await expect(figures.filter({ hasText: "$1.50" })).toBeVisible();
  await expect(figures.filter({ hasText: "2.6M" })).toBeVisible();
  // Counted from the timeline, before the index has learned them.
  await expect(page.locator("dt:text-is('Messages') + dd")).toHaveText("2");
  await expect(page.locator("dt:text-is('Tool calls') + dd")).toHaveText("1");
  await expect(page.getByRole("button", { name: "Copy resume command" })).toHaveAttribute(
    "title",
    "cd '/Users/me/Workspace/demo' && codex resume codex:ses_a",
  );
});

test("the header shows before a long conversation has been read", async ({ page }) => {
  await page.goto("/sessions/codex:ses_a");
  await settle(page, "get_status", status());
  await settle(
    page,
    "get_session",
    session("codex:ses_a", "Fix the parser", { total: 2_625_402, costUsd: 1.5 }),
  );

  // The timeline is still being read, and nothing waits for it.
  await expect(page.getByRole("heading", { name: "Fix the parser" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "$1.50" })).toBeVisible();
  expect(await page.evaluate(() => window.__ipc.pendingCount("get_timeline"))).toBe(1);

  await settle(page, "get_timeline", marks([turn(0, "user", "Fix the parser")]));
  await expect(page.locator("dt:text-is('Messages') + dd")).toHaveText("1");
});

test("a title cut off to fit its line shows in full on hover", async ({ page }) => {
  const title = "Rebuild the index instead of migrating it ".repeat(6).trim();
  await page.goto("/sessions/codex:ses_a");
  await settle(page, "get_status", status());
  await settle(page, "get_session", session("codex:ses_a", title));

  await expect(page.getByRole("heading", { level: 1 })).toHaveAttribute("title", title);
});

test("what was said reads in full, with the steps between gathered", async ({ page }) => {
  await openSession(page, [
    turn(0, "user", "Read the file"),
    turn(1, "reasoning", "I should read it first."),
    turn(2, "tool", "", { name: "Read", input: '{"file_path":"/tmp/x"}', output: "file contents" }),
    turn(3, "assistant", "It says hello."),
  ]);

  await expect(page.getByText("Read the file")).toBeVisible();
  await expect(page.getByText("It says hello.")).toBeVisible();

  const steps = page.getByRole("button", { name: /^Thinking · Read/ });
  await expect(steps).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("I should read it first.")).toBeHidden();
  await steps.click();

  // A call says what it was about while closed, and carries its own result.
  const before = await page.evaluate(() => window.__ipc.calls.length);
  await page.getByRole("button", { name: /Read.*\/tmp\/x/ }).click();
  await expect(page.getByText("file contents")).toBeVisible();
  expect(await page.evaluate(() => window.__ipc.calls.length)).toBe(before);
});

test("a failed tool call says so before it is opened", async ({ page }) => {
  await openSession(page, [
    turn(0, "tool", "", { name: "Bash", input: "false", output: "exit 1", failed: true }),
  ]);

  await expect(page.getByText("Failed")).toBeVisible();
});

test("what the harness added reads as one line that opens", async ({ page }) => {
  await openSession(page, [
    turn(
      0,
      "system",
      "<environment_context>\n<cwd>/Users/me/Workspace</cwd>\n</environment_context>",
    ),
    turn(1, "user", "Fix the parser"),
  ]);

  const note = page.getByRole("button", { name: "Environment context" });
  await expect(note).toBeVisible();
  await expect(page.getByText("<cwd>/Users/me/Workspace</cwd>")).toBeHidden();
  await note.click();
  await expect(page.getByText("<cwd>/Users/me/Workspace</cwd>")).toBeVisible();
});

test("a long conversation pages and says how far it has got", async ({ page }) => {
  const first = Array.from({ length: 150 }, (_, index) =>
    turn(index, "user", `Turn number ${index}`),
  );
  await openSession(page, first, { total: 300 });

  await expect(page.getByText("Turn number 0")).toBeVisible();
  await expect(page.getByText("Showing 150 of 300 turns.")).toBeVisible();

  // The next page is asked for by offset, not by cursor.
  await page.getByText("Turn number 149").scrollIntoViewIfNeeded();
  await expect
    .poll(() => page.evaluate(() => window.__ipc.pendingCount("get_transcript")))
    .toBeGreaterThan(0);
  const asked = await page.evaluate(
    () => window.__ipc.calls.filter((call) => call.cmd === "get_transcript").at(-1)?.args,
  );
  expect((asked as { offset: number }).offset).toBe(150);

  await page.evaluate(
    (data) => window.__ipc.settle("get_transcript", "resolve", data),
    transcript(
      Array.from({ length: 150 }, (_, index) =>
        turn(150 + index, "user", `Turn number ${150 + index}`),
      ),
      { total: 300 },
    ),
  );
  await expect(page.getByText("Turn number 299")).toBeVisible();
});

test("choosing a turn on the timeline reads as far as it and brings it into view", async ({
  page,
}) => {
  const all = Array.from({ length: 300 }, (_, index) =>
    turn(index, index % 2 === 0 ? "user" : "assistant", `Turn number ${index}`),
  );
  await openSession(page, all.slice(0, 150), { total: 300, timeline: all });

  const timeline = page.getByRole("slider", { name: "Timeline" });
  await timeline.focus();
  await page.keyboard.press("End");
  await expect(timeline).toHaveAttribute("aria-valuetext", /Turn number 299/);
  await page.keyboard.press("Enter");

  await expect
    .poll(() => page.evaluate(() => window.__ipc.pendingCount("get_transcript")))
    .toBeGreaterThan(0);
  const asked = await page.evaluate(
    () => window.__ipc.calls.filter((call) => call.cmd === "get_transcript").at(-1)?.args,
  );
  expect((asked as { offset: number }).offset).toBe(150);
  await page.evaluate(
    (data) => window.__ipc.settle("get_transcript", "resolve", data),
    transcript(all.slice(150), { total: 300 }),
  );
  await expect(page.locator("#turn-299")).toBeInViewport();
});

test("a failed page keeps what was already read", async ({ page }) => {
  const first = Array.from({ length: 150 }, (_, index) =>
    turn(index, "user", `Turn number ${index}`),
  );
  await openSession(page, first, { total: 300 });

  await page.getByText("Turn number 149").scrollIntoViewIfNeeded();
  await expect
    .poll(() => page.evaluate(() => window.__ipc.pendingCount("get_transcript")))
    .toBeGreaterThan(0);
  await page.evaluate(
    (failure) => window.__ipc.settle("get_transcript", "reject", failure),
    engineError("read_failed", "could not read the rollout"),
  );

  await expect(page.getByRole("alert")).toContainText("could not read the rollout");
  // Every turn already on screen survives the failure.
  await expect(page.getByText("Turn number 0")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry loading more" })).toBeVisible();
});

test("a session that could not be opened offers a retry", async ({ page }) => {
  await page.goto("/sessions/codex:missing");
  await settle(page, "get_status", status());

  await expect
    .poll(() => page.evaluate(() => window.__ipc.pendingCount("get_session")))
    .toBeGreaterThan(0);
  await page.evaluate(
    (failure) => window.__ipc.settle("get_session", "reject", failure),
    engineError("not_found", "session codex:missing was not found"),
  );

  await expect(page.getByRole("heading", { name: "Could not open this session." })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("was not found");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});
