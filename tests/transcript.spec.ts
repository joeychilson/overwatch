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
  emit,
  engineError,
  installIpc,
  lastArgs,
  marks,
  session,
  settle,
  status,
  transcript,
  turn,
} from "./ipc.ts";
import { lastCopied, recordClipboard } from "./clipboard.ts";

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
  const asked = await lastArgs(page, "get_transcript");
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
  const asked = await lastArgs(page, "get_transcript");
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

test("a message, a block of code and a tool's output each copy as they were recorded", async ({
  page,
}) => {
  await recordClipboard(page);
  await openSession(page, [
    turn(0, "user", "Run the tests"),
    turn(1, "tool", "", { name: "Bash", input: '{"command":"npm test"}', output: "4 passed" }),
    turn(2, "assistant", "They pass. Run them with:\n\n```sh\nnpm test\n```"),
  ]);

  await page.getByText("Run the tests").hover();
  await page.getByRole("button", { name: "Copy message" }).first().click();
  expect(await lastCopied(page)).toBe("Run the tests");

  await page.getByText("They pass.").hover();
  await page.getByRole("button", { name: "Copy code" }).click();
  expect(await lastCopied(page)).toBe("npm test");

  await page.getByRole("button", { name: /Bash.*npm test/ }).click();
  const output = page.getByRole("button", { name: "Copy output" });
  await output.click();
  expect(await lastCopied(page)).toBe("4 passed");
  // The button says it copied, by name as well as by its icon.
  await expect(output).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copied" })).not.toHaveCount(0);
});

test("the whole conversation copies as Markdown, past what is on screen", async ({ page }) => {
  await recordClipboard(page);
  const turns = [
    turn(0, "user", "Fix the parser"),
    turn(1, "tool", "", { name: "exec", input: "pwd", output: "/w" }),
    turn(2, "assistant", "Fixed."),
  ];
  await openSession(page, turns.slice(0, 1), { total: 3, timeline: turns });

  await page.getByRole("button", { name: "Copy the conversation as Markdown" }).click();
  // The rest is read from where the pages left off, a page at a time.
  await settle(page, "get_transcript", transcript(turns.slice(0, 2), { total: 3 }));
  await settle(page, "get_transcript", transcript(turns.slice(2), { total: 3 }));

  const copied = (await lastCopied(page)) ?? "";
  expect(copied).toMatch(/^# Fix the parser\n\nCodex · /);
  expect(copied).toContain("\n\nFix the parser\n\n*exec*\n\n## Codex");
  expect(copied).toMatch(/Fixed\.\n$/);
});

/** Open a session last active at `activeAt` and answer its first reads. */
async function openLive(page: Page, turns: Turns, activeAt: number, total = turns.length) {
  await page.goto("/sessions/codex:ses_a");
  await settle(page, "get_status", status());
  await settle(
    page,
    "get_session",
    session("codex:ses_a", "Fix the parser", { updatedAt: activeAt }),
  );
  await settle(page, "get_timeline", marks(turns));
  await settle(page, "get_transcript", transcript(turns, { total }));
}

/**
 * A scan reads something new of the sessions named, as the engine announces
 * it: the index changes, the session is read again as last active at
 * `activeAt`, and the changed sessions are named.
 */
async function scanFinds(page: Page, activeAt: number, changed = ["codex:ses_a"]) {
  await emit(page, "index_changed", status({ filesRead: 1 }));
  await settle(
    page,
    "get_session",
    session("codex:ses_a", "Fix the parser", { updatedAt: activeAt }),
  );
  await emit(page, "sessions_changed", changed);
}

test("a live session fills in as its agent works, a tool's result landing in its call", async ({
  page,
}) => {
  const now = Date.now();
  const running = [
    turn(0, "user", "Fix the parser"),
    turn(1, "tool", "", { name: "exec", input: "cargo test", output: null }),
  ];
  await openLive(page, running, now);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();

  const done = [
    turn(0, "user", "Fix the parser"),
    turn(1, "tool", "", { name: "exec", input: "cargo test", output: "12 passed" }),
    turn(2, "assistant", "Fixed, and the tests pass."),
  ];
  await scanFinds(page, now + 5_000);
  await settle(page, "get_timeline", marks(done));
  await settle(page, "get_transcript", transcript(done));
  // The newest turns are read again from before the end, not only past it.
  expect(await lastArgs(page, "get_transcript")).toMatchObject({ offset: 0 });

  await expect(page.getByText("Fixed, and the tests pass.")).toBeVisible();
  await expect(page.locator("dt:text-is('Messages') + dd")).toHaveText("2");
  await page.getByRole("button", { name: /exec.*cargo test/ }).click();
  await expect(page.getByText("12 passed")).toBeVisible();
});

test("a session the index changed around but not in is not read again", async ({ page }) => {
  const now = Date.now();
  await openLive(page, [turn(0, "user", "Fix the parser")], now);
  const reads = () =>
    page.evaluate(
      () =>
        window.__ipc.calls.filter(
          (call) => call.cmd === "get_timeline" || call.cmd === "get_transcript",
        ).length,
    );
  const before = await reads();

  await scanFinds(page, now, ["codex:ses_b"]);
  await page.waitForTimeout(250);
  expect(await reads()).toBe(before);
});

test("reading further up, what arrives waits below behind a notice", async ({ page }) => {
  const now = Date.now();
  const said = Array.from({ length: 60 }, (_, index) =>
    turn(index, index % 2 === 0 ? "user" : "assistant", `Turn number ${index}`),
  );
  await openLive(page, said, now);
  const main = page.getByRole("main");
  await main.evaluate((element) => element.scrollTo(0, 0));

  const more = [...said, turn(60, "assistant", "Something new")];
  await scanFinds(page, now + 5_000);
  await settle(page, "get_timeline", marks(more));
  await settle(page, "get_transcript", transcript(more));

  const notice = page.getByRole("button", { name: "Newer turns" });
  await expect(notice).toBeVisible();
  expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
  await notice.click();
  await expect(page.getByText("Something new")).toBeInViewport();
  await expect(notice).toBeHidden();
});

test("before the end has been read, only how far the session goes is learned", async ({ page }) => {
  const now = Date.now();
  const first = Array.from({ length: 150 }, (_, index) =>
    turn(index, "user", `Turn number ${index}`),
  );
  await openLive(page, first, now, 300);
  await expect(page.getByText("Showing 150 of 300 turns.")).toBeVisible();

  await scanFinds(page, now + 5_000);
  await settle(page, "get_timeline", marks(first));
  await settle(page, "get_transcript", transcript([turn(150, "user", "Next")], { total: 301 }));
  expect(await lastArgs(page, "get_transcript")).toMatchObject({ offset: 150, limit: 1 });
  await expect(page.getByText("Showing 150 of 301 turns.")).toBeVisible();
  await expect(page.getByText("Next", { exact: true })).toHaveCount(0);
});

test("a reader at the bottom stays there as what the agent adds arrives", async ({ page }) => {
  const now = Date.now();
  const said = Array.from({ length: 60 }, (_, index) =>
    turn(index, index % 2 === 0 ? "user" : "assistant", `Turn number ${index}`),
  );
  await openLive(page, said, now);
  const main = page.getByRole("main");
  await main.evaluate((element) => element.scrollTo(0, element.scrollHeight));

  const more = [...said, turn(60, "assistant", "Something new")];
  await scanFinds(page, now + 5_000);
  await settle(page, "get_timeline", marks(more));
  await settle(page, "get_transcript", transcript(more));

  await expect(page.getByText("Something new")).toBeInViewport();
  await expect(page.getByRole("button", { name: "Newer turns" })).toHaveCount(0);
});

test("finding steps through the turns found, reading as far as each", async ({ page }) => {
  const all = Array.from({ length: 300 }, (_, index) =>
    turn(index, index % 2 === 0 ? "user" : "assistant", `Turn number ${index}`),
  );
  await openSession(page, all.slice(0, 150), { total: 300, timeline: all });

  await emit(page, "command", "find");
  const box = page.getByRole("searchbox", { name: "Find in conversation" });
  await expect(box).toBeFocused();
  await box.fill("needle");
  await settle(page, "find_in_transcript", [3, 250]);
  expect(await lastArgs(page, "find_in_transcript")).toEqual({
    id: "codex:ses_a",
    query: "needle",
  });
  await expect(page).toHaveURL(/\?find=needle$/);
  await expect(page.getByRole("status")).toHaveText("1 of 2");
  await expect(page.locator("#turn-3")).toBeInViewport();

  // The next one is past what has been read, so it is read as far as first.
  await box.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__ipc.pendingCount("get_transcript")))
    .toBeGreaterThan(0);
  await settle(page, "get_transcript", transcript(all.slice(150), { total: 300 }));
  await expect(page.locator("#turn-250")).toBeInViewport();
  await expect(page.getByRole("status")).toHaveText("2 of 2");

  await box.press("Shift+Enter");
  await expect(page.getByRole("status")).toHaveText("1 of 2");
  // The menu's Find Next goes round from the last to the first.
  await emit(page, "command", "find_previous");
  await expect(page.getByRole("status")).toHaveText("2 of 2");

  await box.press("Escape");
  await expect(box).toBeHidden();
  await expect(page).toHaveURL(/\/sessions\/codex:ses_a$/);
});

test("a tool call found by a search opens to show what was found", async ({ page }) => {
  await recordClipboard(page);
  await page.goto("/sessions/codex:ses_a?find=panicked");
  await settle(page, "get_status", status());
  await settle(page, "get_session", session("codex:ses_a", "Fix the parser"));
  const turns = [
    turn(0, "user", "Run the tests"),
    turn(1, "reasoning", "Running them."),
    turn(2, "tool", "", { name: "Bash", input: "cargo test", output: "thread panicked" }),
    turn(3, "assistant", "One failed."),
  ];
  await settle(page, "get_timeline", marks(turns));
  await settle(page, "get_transcript", transcript(turns));
  await settle(page, "find_in_transcript", [2]);

  await expect(page.getByRole("searchbox", { name: "Find in conversation" })).toHaveValue(
    "panicked",
  );
  await expect(page.getByRole("status")).toHaveText("1 of 1");
  await expect(page.getByText("thread panicked")).toBeVisible();
});

test("a search that finds nothing says so", async ({ page }) => {
  await page.goto("/sessions/codex:ses_a?find=absent");
  await settle(page, "get_status", status());
  await settle(page, "get_session", session("codex:ses_a", "Fix the parser"));
  await settle(page, "get_timeline", marks([turn(0, "user", "Fix the parser")]));
  await settle(page, "get_transcript", transcript([turn(0, "user", "Fix the parser")]));
  await settle(page, "find_in_transcript", []);

  await expect(page.getByRole("status")).toHaveText("No matches");
  await expect(page.getByRole("button", { name: "Next match" })).toBeDisabled();
});

test("a search runs again as the session changes, staying on the turn it was on", async ({
  page,
}) => {
  const turns = [
    turn(0, "user", "Find the needle"),
    turn(1, "assistant", "Looking."),
    turn(2, "user", "Keep going"),
  ];
  await page.goto("/sessions/codex:ses_a?find=needle");
  await settle(page, "get_status", status());
  await settle(page, "get_session", session("codex:ses_a", "Fix the parser"));
  await settle(page, "get_timeline", marks(turns));
  await settle(page, "get_transcript", transcript(turns));
  await settle(page, "find_in_transcript", [0]);
  await expect(page.getByRole("status")).toHaveText("1 of 1");

  await emit(page, "sessions_changed", ["codex:ses_a"]);
  await settle(page, "find_in_transcript", [0, 3]);
  await expect(page.getByRole("status")).toHaveText("1 of 2");
  await expect(page.locator("#turn-0")).toBeInViewport();
});
