import { describe, expect, test } from "vite-plus/test";
import { CLIENTS, isTranslocated, shellWord, steps } from "./connect.ts";

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

describe("steps", () => {
  test("registers the server with each agent's own command, at the user's scope", () => {
    const command = (client: (typeof CLIENTS)[number]) => steps(client, INSTALLED)[0]?.code;
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
    expect(steps("codex", moved)[0]?.code).toBe(
      "codex mcp add overwatch -- '/Users/me/My Apps/Overwatch.app/Contents/MacOS/overwatch' mcp",
    );
    // JSON carries the path as it is.
    const [configuration] = steps("other", moved);
    expect(JSON.parse(configuration?.code ?? "")).toEqual({
      mcpServers: { overwatch: moved },
    });
  });

  test("has steps for every client offered, which are the agents with MCP of their own", () => {
    expect(CLIENTS).toEqual(["claude_code", "codex", "open_code", "grok_build", "other"]);
    for (const client of CLIENTS) expect(steps(client, INSTALLED).length).toBeGreaterThan(0);
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
