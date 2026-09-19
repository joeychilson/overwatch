import { describe, expect, test } from "vite-plus/test";
import type { Turn } from "./api/backend.ts";
import {
  IDLE,
  activeTime,
  asMarkdown,
  blocks,
  findPattern,
  noteTitle,
  stepsSummary,
  toolKind,
  toolSubject,
} from "./transcript.ts";

test("a session is active between its turns, not across its long pauses", () => {
  const minute = 60_000;
  const at = [0, 2 * minute, null, 5 * minute, 5 * minute + IDLE + 1, 7 * minute + IDLE + 1];
  expect(activeTime(at.map((when) => ({ at: when })))).toBe(7 * minute);
  expect(activeTime([{ at: null }])).toBeNull();
});

function turn(
  index: number,
  speaker: Turn["speaker"],
  text = "",
  tool: Turn["tool"] = null,
  at: number | null = null,
): Turn {
  return { index, speaker, at, model: null, text, tool };
}

function call(name: string, input: string) {
  return { name, input, output: null, failed: false };
}

describe("layout", () => {
  test("gathers the steps between things said", () => {
    const laid = blocks([
      turn(0, "system", "<environment_context>"),
      turn(6, "system", "# AGENTS.md instructions for /w"),
      turn(1, "user", "Fix it", null, new Date(2026, 8, 1, 9).getTime()),
      turn(2, "reasoning", "Looking."),
      turn(3, "tool", "", call("Bash", '{"command":"ls"}')),
      turn(4, "assistant", "Done.", null, new Date(2026, 8, 1, 10).getTime()),
      turn(5, "user", "Again", null, new Date(2026, 8, 2, 9).getTime()),
    ]);
    expect(laid.map((block) => [block.kind, block.index])).toEqual([
      ["notes", 0],
      ["message", 1],
      ["steps", 2],
      ["message", 4],
      ["message", 5],
    ]);
    // The day is named when it changes.
    expect(laid.map((block) => (block.kind === "message" ? block.dated : null))).toEqual([
      null,
      true,
      null,
      false,
      true,
    ]);
  });
});

test("a search is found as written, ignoring case, each mention at an odd position", () => {
  const pattern = findPattern(" a.b(c) ");
  expect("x A.B(C) y a.b(c)".split(pattern ?? "")).toEqual(["x ", "A.B(C)", " y ", "a.b(c)", ""]);
  expect("aXb(c)".split(pattern ?? "")).toEqual(["aXb(c)"]);
  expect(findPattern("   ")).toBeNull();
});

describe("tool calls", () => {
  test("say what they were about", () => {
    const bash = '{"command":"vp check\\nvp test","description":"Check"}';
    expect(toolSubject(call("Bash", bash))).toBe("vp check");
    expect(toolSubject(call("Read", '{"file_path":"/w/src/lib.rs"}'))).toBe("/w/src/lib.rs");
    const exec = 'const r = await tools.exec_command({"cmd":"git status"}); text(r.output);';
    expect(toolSubject(call("exec", exec))).toBe("git status");
    const patch = "*** Begin Patch\n*** Update File: src/main.rs\n@@";
    expect(toolSubject(call("apply_patch", patch))).toBe("src/main.rs");
    expect(toolSubject(call("shell", '{"command":["bash","-lc","ls"]}'))).toBe("bash -lc ls");
    expect(toolSubject(call("exec", "pwd"))).toBe("pwd");
    expect(toolSubject(call("computer", '{"action":"screenshot"}'))).toBe("");
  });

  test("are known by what they do, whatever the agent calls them", () => {
    expect(toolKind("Bash")).toBe("command");
    expect(toolKind("apply_patch")).toBe("edit");
    expect(toolKind("collaboration.spawn_agent")).toBe("agent");
    expect(toolKind("mcp__cua_repl.js")).toBe("other");
  });
});

describe("notes", () => {
  test("read as what the harness calls them", () => {
    expect(noteTitle("<environment_context>\n<cwd>/w</cwd>")).toBe("Environment context");
    expect(noteTitle("# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>")).toBe(
      "AGENTS.md instructions for /w",
    );
    expect(noteTitle("[Request interrupted by user]")).toBe("Request interrupted by user");
    const notice = '<task-notification>\n<summary>Agent "Research" finished</summary>';
    expect(noteTitle(notice)).toBe('Agent "Research" finished');
    expect(noteTitle("Set model to Opus")).toBe("Set model to Opus");
  });
});

describe("steps", () => {
  test("are summed up by the tools used most", () => {
    const tools = ["Bash", "Bash", "Edit", "Bash"].map((name, index) =>
      turn(index, "tool", "", call(name, "{}")),
    );
    expect(stepsSummary([...tools, turn(9, "reasoning", "Hm")])).toBe("Bash ×3 · Edit · Thinking");
  });
});

test("a conversation as Markdown keeps what was said and names the steps between", () => {
  const at = (day: number, hour: number, minute: number) =>
    new Date(2026, 8, day, hour, minute).getTime();
  const markdown = asMarkdown({
    title: "Add idempotency keys",
    about: "Claude Code · ledger-api",
    agent: "Claude Code",
    now: new Date(2026, 8, 18),
    turns: [
      turn(0, "system", "<environment_context>"),
      turn(1, "user", "Add keys to **POST /payments**\n", null, at(14, 12, 58)),
      turn(2, "reasoning", "Looking."),
      turn(3, "tool", "", call("Read", "{}")),
      turn(4, "tool", "", { name: "Bash", input: "npm test", output: "1 failed", failed: true }),
      turn(5, "assistant", "Done.", null, at(14, 13, 0)),
      turn(6, "user", "Thanks", null, at(15, 9, 5)),
      turn(7, "assistant", "No time was recorded for this."),
    ],
  });
  // Times are written with the narrow space the locale puts before the meridiem.
  expect(markdown.replaceAll("\u202f", " ")).toBe(
    [
      "# Add idempotency keys",
      "Claude Code · ledger-api",
      "## You · Sep 14, 12:58 PM",
      "Add keys to **POST /payments**",
      "*Thinking · Read · Bash · 1 failed*",
      "## Claude Code · 1:00 PM",
      "Done.",
      "## You · Sep 15, 9:05 AM",
      "Thanks",
      "## Claude Code",
      "No time was recorded for this.",
    ].join("\n\n") + "\n",
  );
});
