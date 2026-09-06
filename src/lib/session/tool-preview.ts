import type { SessionEvent } from "../bindings";

export type Snippet = {
  text: string;
  match: { start: number; end: number } | null;
};
type ToolKind = "command" | "file" | "search" | "other";
type ToolInput = { kind: ToolKind; text: string | null };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decoded(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    // Commands, patches, and clipped JSON are valid recorded inputs; retain their text.
    if (error instanceof SyntaxError) return text;
    throw error;
  }
}

function field(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return item;
  }
  return null;
}

function firstLine(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  const end = value.search(/[\r\n]/);
  return end < 0 ? value : `${value.slice(0, end).trimEnd()} …`;
}

function relative(path: string, cwd: string): string {
  const root = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  const value = path.replaceAll("\\", "/");
  return root && value.startsWith(`${root}/`) ? value.slice(root.length + 1) : path;
}

function line(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function range(input: Record<string, unknown>, name: string): string {
  const read = name.split(/[.:/]/).at(-1)?.toLowerCase() === "read";
  const view = Array.isArray(input.view_range) ? input.view_range : [];
  const start = line(
    input.start_line ?? input.startLine ?? view[0] ?? (read ? input.offset : null),
  );
  const limit = read ? line(input.limit) : null;
  const end =
    line(input.end_line ?? input.endLine ?? view[1]) ??
    (start && limit ? line(start + limit - 1) : null);
  if (start && end && end >= start) return ` · lines ${start}–${end}`;
  return start ? ` · from line ${start}` : "";
}

function inputSummary(name: string, text: string, cwd: string): ToolInput {
  const value = decoded(text);
  const input = record(value) ? value : null;
  const patch = input
    ? field(input, "patch", "patchText", "input")
    : typeof value === "string"
      ? value
      : "";
  if (patch) {
    const files = [
      ...new Set(
        [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) =>
          relative(match[1].trim(), cwd),
        ),
      ),
    ];
    if (files.length)
      return {
        kind: "file",
        text: `${files[0]}${files.length > 1 ? ` · ${files.length - 1} more ${files.length === 2 ? "file" : "files"}` : ""}`,
      };
  }
  if (!input)
    return {
      kind: /(?:^|[._:/])(bash|exec|exec_command|shell|shell_command|run_command|terminal)$/i.test(
        name,
      )
        ? "command"
        : "other",
      text: value === null ? null : firstLine(typeof value === "string" ? value : text),
    };
  const command = field(input, "command", "cmd", "script", "code");
  if (command) return { kind: "command", text: firstLine(command) };
  const argv = input.command ?? input.cmd;
  if (Array.isArray(argv) && argv.length && argv.every((argument) => typeof argument === "string"))
    return { kind: "command", text: firstLine(argv.join(" ")) };
  const path = field(input, "file_path", "filePath", "path", "filename");
  const query = field(input, "pattern", "query", "search_query", "glob");
  if (query)
    return {
      kind: "search",
      text: `${firstLine(query)}${path ? ` · ${relative(path, cwd)}` : ""}`,
    };
  if (path) return { kind: "file", text: `${relative(path, cwd)}${range(input, name)}` };
  const preferred = field(input, "url", "prompt", "description", "text", "input");
  if (preferred) return { kind: "other", text: firstLine(preferred) };
  for (const [key, item] of Object.entries(input)) {
    if (typeof item === "string" && item.trim())
      return { kind: "other", text: `${key}: ${firstLine(item)}` };
    if (typeof item === "number" || typeof item === "boolean")
      return { kind: "other", text: `${key}: ${item}` };
  }
  return { kind: "other", text: Object.keys(input).length ? firstLine(text) : null };
}

function stripAnsi(text: string): string {
  // Terminal output can contain ANSI control sequences; remove them from plain-text previews.
  // oxlint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** Plain-text, bounded excerpts. Match offsets refer to the displayed text, never HTML. */
export function snippet(text: string | null, search = ""): Snippet | null {
  if (!text?.trim()) return null;
  const compact = stripAnsi(text).replace(/\s+/g, " ").trim();
  if (!compact) return null;
  const query = search.replace(/\s+/g, " ").trim();
  const found = query
    ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").exec(compact)
    : null;
  const start = found ? Math.max(0, found.index - 32) : 0;
  const end = Math.min(compact.length, start + 180);
  const prefix = start > 0 ? "… " : "";
  return {
    text: `${prefix}${compact.slice(start, end)}${end < compact.length ? " …" : ""}`,
    match: found
      ? {
          start: prefix.length + found.index - start,
          end: prefix.length + Math.min(found.index + found[0].length, end) - start,
        }
      : null,
  };
}

function errorSummary(output: string): string | null {
  const value = decoded(output);
  if (record(value)) {
    if (record(value.error)) {
      const message = field(value.error, "message", "error", "detail");
      if (message) return firstLine(message);
    }
    const message = field(value, "error", "stderr", "message", "detail");
    if (message) return firstLine(message);
  }
  const text = stripAnsi(typeof value === "string" ? value : output);
  const failure = text
    .split(/\r?\n/)
    .find((line) =>
      /\b(error|exception|failed|fatal|denied|ENOENT)\b|not found|no such file/i.test(line),
    );
  return failure?.trim() || firstLine(text);
}

export function toolPreview(
  event: Pick<SessionEvent, "tool" | "text" | "output" | "failed">,
  cwd: string,
  search: string,
) {
  const summary = inputSummary(event.tool ?? "", event.text, cwd);
  let input = snippet(summary.text, search);
  if (search && !input?.match) {
    const match = snippet(event.text, search);
    if (match?.match) input = match;
  }
  const error = event.failed && event.output ? snippet(errorSummary(event.output), search) : null;
  const output = search && !input?.match && !error?.match ? snippet(event.output, search) : null;
  return {
    kind: summary.kind,
    input,
    error,
    output: output?.match ? output : null,
    name: snippet(event.tool ?? "Tool", search),
  };
}
