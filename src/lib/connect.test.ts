import { describe, expect, test } from "vite-plus/test";
import { CLIENTS, isTranslocated, shellWord, step } from "./connect.ts";

const INSTALLED = {
  command: "/Applications/Overwatch.app/Contents/MacOS/overwatch",
  args: ["mcp"],
};

describe("shellWord", () => {
  test("leaves a plain path as it is", () => {
    expect(shellWord(INSTALLED.command)).toBe(INSTALLED.command);
  });

  test("quotes a path a shell would split or expand", () => {
    expect(shellWord("/Users/me/My Apps/overwatch")).toBe("'/Users/me/My Apps/overwatch'");
    expect(shellWord("/Users/me/$HOME")).toBe("'/Users/me/$HOME'");
    expect(shellWord("/Users/me/Joey's/overwatch")).toBe(`'/Users/me/Joey'\\''s/overwatch'`);
    expect(shellWord("")).toBe("''");
  });
});

describe("step", () => {
  test("registers the server with each agent's own command, at the user's scope", () => {
    const command = (client: (typeof CLIENTS)[number]) => step(client, INSTALLED).code;
    const start = "/Applications/Overwatch.app/Contents/MacOS/overwatch mcp";
    expect(command("claude_code")).toBe(`claude mcp add --scope user overwatch -- ${start}`);
    expect(command("codex")).toBe(`codex mcp add overwatch -- ${start}`);
    expect(command("open_code")).toBe(`opencode mcp add --global overwatch -- ${start}`);
    expect(command("grok_build")).toBe(`grok mcp add overwatch -- ${start}`);
  });

  test("quotes an executable whose path has a space in a command", () => {
    const moved = {
      command: "/Users/me/My Apps/Overwatch.app/Contents/MacOS/overwatch",
      args: ["mcp"],
    };
    expect(step("codex", moved).code).toBe(
      "codex mcp add overwatch -- '/Users/me/My Apps/Overwatch.app/Contents/MacOS/overwatch' mcp",
    );
    // JSON carries the path as it is.
    expect(JSON.parse(step("other", moved).code)).toEqual({
      mcpServers: { overwatch: moved },
    });
  });

  test("keeps a list of arguments on one line, and every value as it is", () => {
    expect(step("other", INSTALLED).code).toContain(`"args": ["mcp"]`);
    // Brackets, braces and commas inside the values must not be taken for the list's own.
    const tricky = { command: "/Apps/[x], {y}/overwatch", args: ["mcp", "a],\n b"] };
    expect(JSON.parse(step("other", tricky).code)).toEqual({ mcpServers: { overwatch: tricky } });
  });

  test("offers the agents with MCP of their own, then any other client", () => {
    expect(CLIENTS).toEqual(["claude_code", "codex", "open_code", "grok_build", "other"]);
  });
});

test("an executable macOS is running from a translocated copy is recognised", () => {
  expect(
    isTranslocated(
      "/private/var/folders/x1/T/AppTranslocation/0A1B/d/Overwatch.app/Contents/MacOS/overwatch",
    ),
  ).toBe(true);
  expect(isTranslocated(INSTALLED.command)).toBe(false);
});
