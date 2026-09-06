import { describe, expect, it } from "vite-plus/test";
import { snippet, toolPreview } from "./tool-preview";

function preview(
  tool: string,
  input: unknown,
  output: string | null = null,
  failed = false,
  search = "",
) {
  return toolPreview(
    { tool, text: typeof input === "string" ? input : JSON.stringify(input), output, failed },
    "/work/project",
    search,
  );
}

describe("tool previews", () => {
  it("extracts commands across providers and keeps multiline commands on one line", () => {
    expect(
      preview("exec_command", { cmd: "rg session src", yield_time_ms: 1000 }).input?.text,
    ).toBe("rg session src");
    expect(preview("shell", { command: ["git", "diff", "--stat"] }).input?.text).toBe(
      "git diff --stat",
    );
    expect(preview("Bash", "\n  pwd\nrg session src")).toMatchObject({
      kind: "command",
      input: { text: "pwd …" },
    });
    expect(
      preview("functions.exec", { code: "const result = await read();\ntext(result);" }).input
        ?.text,
    ).toBe("const result = await read(); …");
  });

  it("shows relative files and explicit ranges without assuming every offset counts lines", () => {
    expect(
      preview("Read", { file_path: "/work/project/src/app.tsx", offset: 120, limit: 61 }).input
        ?.text,
    ).toBe("src/app.tsx · lines 120–180");
    expect(preview("read", { filePath: "src/app.tsx", offset: 12 }).input?.text).toBe(
      "src/app.tsx · from line 12",
    );
    expect(preview("read_file", { path: "app.tsx", start_line: 3, end_line: 8 }).input?.text).toBe(
      "app.tsx · lines 3–8",
    );
    expect(preview("view", { path: "app.tsx", view_range: [4, 10] }).input?.text).toBe(
      "app.tsx · lines 4–10",
    );
    expect(
      preview("unknown", { path: "/work/project-copy/data", offset: 12, limit: 20 }).input?.text,
    ).toBe("/work/project-copy/data");
    expect(preview("Read", { path: "app.tsx", offset: -1, limit: 10 }).input?.text).toBe("app.tsx");
  });

  it("summarizes patch targets and edit paths instead of large replacement bodies", () => {
    const patch =
      "*** Begin Patch\n*** Update File: /work/project/src/app.tsx\n@@\n-old\n+new\n*** Add File: src/log.tsx\n+content\n*** End Patch";
    expect(preview("apply_patch", patch)).toMatchObject({
      kind: "file",
      input: { text: "src/app.tsx · 1 more file" },
    });
    expect(preview("apply_patch", { patchText: patch }).input?.text).toBe(
      "src/app.tsx · 1 more file",
    );
    expect(
      preview("Edit", {
        file_path: "src/app.tsx",
        old_string: "old",
        new_string: "replacement ".repeat(4000),
      }).input?.text,
    ).toBe("src/app.tsx");
  });

  it("chooses search scope and useful fields with a faithful fallback for unfamiliar inputs", () => {
    expect(preview("Grep", { pattern: "useQuery", path: "/work/project/src" })).toMatchObject({
      kind: "search",
      input: { text: "useQuery · src" },
    });
    expect(preview("mcp__repo__search", { query: "virtualizer" }).kind).toBe("search");
    expect(preview("fetch", { url: "https://example.com", timeout: 1000 }).input?.text).toBe(
      "https://example.com",
    );
    expect(preview("custom", { target: "reader" }).input?.text).toBe("target: reader");
    expect(preview("custom", {}).input).toBeNull();
    expect(preview("custom", null).input).toBeNull();
    expect(preview("custom", "raw input\nsecond line").input?.text).toBe("raw input …");
    expect(preview("custom", '{"command":"clipped').input?.text).toBe('{"command":"clipped');
  });

  it("extracts failed-call errors without treating successful output as a failure", () => {
    expect(
      preview(
        "Bash",
        { command: "vp test" },
        "Starting tests\n\u001b[31mError: missing fixture\u001b[0m\nStack trace",
        true,
      ).error?.text,
    ).toBe("Error: missing fixture");
    expect(
      preview(
        "fetch",
        {},
        JSON.stringify({ error: { message: "Request denied", code: 403 } }),
        true,
      ).error?.text,
    ).toBe("Request denied");
    expect(preview("Bash", {}, "All error handling tests passed", false).error).toBeNull();
    expect(preview("Bash", {}, null, true).error).toBeNull();
  });

  it("finds literal search matches deep in input and output and keeps excerpts bounded", () => {
    const input = preview(
      "Edit",
      { file_path: "app.tsx", new_string: `${"before ".repeat(5000)}[a.*] after` },
      null,
      false,
      "[a.*]",
    );
    expect(input.input?.text).toContain("[a.*]");
    expect(input.input?.match).not.toBeNull();
    expect(input.input!.text.slice(input.input!.match!.start, input.input!.match!.end)).toBe(
      "[a.*]",
    );
    expect(input.input!.text.length).toBeLessThanOrEqual(184);
    const output = preview(
      "Bash",
      { command: "vp test" },
      `${"log ".repeat(10000)}output-needle done`,
      false,
      "OUTPUT-NEEDLE",
    );
    expect(output.input?.text).toBe("vp test");
    expect(output.output?.text).toContain("output-needle");
    expect(output.output!.text.slice(output.output!.match!.start, output.output!.match!.end)).toBe(
      "output-needle",
    );
    expect(output.output!.text.length).toBeLessThanOrEqual(184);
  });

  it("preserves highlight offsets in Unicode text and never interprets search as markup", () => {
    const value = snippet("İ α READ_FILE <script>", "read_file");
    expect(value!.text.slice(value!.match!.start, value!.match!.end)).toBe("READ_FILE");
    expect(snippet("<script>", "<script>")).toEqual({
      text: "<script>",
      match: { start: 0, end: 8 },
    });
    expect(snippet("  a\n b ", "")).toEqual({ text: "a b", match: null });
    expect(snippet("   ")).toBeNull();
  });
});
