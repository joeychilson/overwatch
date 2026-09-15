/**
 * How a conversation is laid out for reading.
 *
 * What the person and the model said is the conversation, and reads in full.
 * The steps between — thinking, and the tools the model ran — are how a reply
 * was reached, so a run of them gathers into one block that opens on request.
 * What the harness added reads as a line naming it, and several in a row share
 * one.
 */
import type { ToolCall, Turn } from "./api/backend.ts";
import { startOfDay } from "./periods.ts";

/** How long a pause between turns runs before the session counts as idle. */
export const IDLE = 20 * 60_000;

/**
 * How long a session was active: the time between its turns, leaving out any
 * pause longer than {@link IDLE}. Null when no turn records a time.
 */
export function activeTime(turns: readonly { at: number | null }[]): number | null {
  const times = turns.flatMap((turn) => (turn.at === null ? [] : [turn.at])).sort((a, b) => a - b);
  if (times.length === 0) return null;
  let active = 0;
  for (const [position, at] of times.entries()) {
    const pause = at - (times[position - 1] ?? at);
    if (pause <= IDLE) active += pause;
  }
  return active;
}

/** One block of a laid-out conversation, named by the index of its first turn. */
export type Block =
  /** Something said; `dated` when it is the first said on its day. */
  | { kind: "message"; index: number; turn: Turn; dated: boolean }
  | { kind: "notes"; index: number; turns: Turn[] }
  | { kind: "steps"; index: number; turns: Turn[] };

/** Lay turns out as blocks, in order. */
export function blocks(turns: readonly Turn[]): Block[] {
  const laid: Block[] = [];
  let day: number | null = null;
  for (const turn of turns) {
    if (turn.speaker === "user" || turn.speaker === "assistant") {
      const today: number | null = turn.at === null ? day : startOfDay(turn.at);
      laid.push({ kind: "message", index: turn.index, turn, dated: today !== day });
      day = today;
    } else if (turn.speaker === "system") {
      const last = laid.at(-1);
      if (last?.kind === "notes") last.turns.push(turn);
      else laid.push({ kind: "notes", index: turn.index, turns: [turn] });
    } else {
      const last = laid.at(-1);
      if (last?.kind === "steps") last.turns.push(turn);
      else laid.push({ kind: "steps", index: turn.index, turns: [turn] });
    }
  }
  return laid;
}

/** The first line of a text with anything on it. */
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

/** What a tool does, as far as its icon says. */
export type ToolKind = "command" | "edit" | "read" | "search" | "web" | "agent" | "other";

/** The names agents give their tools, by what the tools do. */
const KINDS: readonly (readonly [ToolKind, readonly string[]])[] = [
  ["command", ["bash", "exec", "shell", "exec_command", "local_shell", "run_terminal_cmd"]],
  ["edit", ["edit", "multiedit", "write", "apply_patch", "patch", "write_file", "edit_file"]],
  ["read", ["read", "read_file", "view", "list_dir", "ls"]],
  ["search", ["grep", "glob", "search", "find", "codebase_search", "toolsearch"]],
  ["web", ["webfetch", "websearch", "web_search", "fetch"]],
  ["agent", ["agent", "task", "spawn_agent", "send_message", "followup_task", "wait_agent"]],
];

/** What a tool does, from its name without any namespace. */
export function toolKind(name: string): ToolKind {
  const bare = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return KINDS.find(([, names]) => names.includes(bare))?.[0] ?? "other";
}

/** Arguments that say what a call was about, the most telling first. */
const SUBJECTS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "task_name",
  "target",
  "message",
  "prompt",
];

/**
 * What a tool call was about, in a line: its command, file, query or address.
 *
 * Arguments are mostly JSON, and the telling one has much the same name in
 * every agent. Codex wraps the JSON of a code-mode call in a line of script and
 * names a patch's files in its header, so both are looked inside.
 */
export function toolSubject(tool: ToolCall): string {
  const input = tool.input.trim();
  const patched = input.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1];
  if (patched) return patched;
  const args = object(input) ?? object(input.slice(input.indexOf("{"), input.lastIndexOf("}") + 1));
  if (args === null) return firstLine(input);
  for (const key of SUBJECTS) {
    const value = args[key];
    const text = Array.isArray(value) ? value.join(" ") : value;
    if (typeof text === "string" && text.trim() !== "") return firstLine(text);
  }
  return "";
}

/** A JSON object's fields, or null when the text is not one. */
function object(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A line naming what the harness added: what its markup calls it, or its first
 * line of text.
 */
export function noteTitle(text: string): string {
  const opened = text.trimStart();
  if (opened.startsWith("<task-notification>")) {
    const summary = opened.match(/<summary>([^<]+)<\/summary>/)?.[1];
    if (summary) return summary.trim();
  }
  const tag = opened.match(/^<([a-z][\w-]*)/i)?.[1];
  if (tag) {
    const words = tag.replaceAll(/[_-]/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return firstLine(text)
    .replace(/^#+\s*/, "")
    .replace(/^\[(.+)\]$/, "$1");
}

/** What a run of steps did, by the tools used most, such as `Bash ×8 · Edit ×3`. */
export function stepsSummary(turns: readonly Turn[]): string {
  const counts = new Map<string, number>();
  for (const turn of turns) {
    const name = turn.tool?.name ?? "Thinking";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const named = ranked.slice(0, 3).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const rest = ranked.length - named.length;
  return [...named, ...(rest > 0 ? [`${rest} more`] : [])].join(" · ");
}
