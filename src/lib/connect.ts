/**
 * How each agent is connected to Overwatch's MCP server.
 *
 * Every agent keeps its own list of MCP servers, so connecting one is a
 * command run in a terminal, or a few lines added to a file, naming this app's
 * executable. Overwatch never writes an agent's files itself, so the reader
 * carries out the step.
 */
import { AGENTS, type Agent, type McpServer } from "./api/backend.ts";

/**
 * Who can be connected: an agent Overwatch reads that has MCP of its own, or
 * any other MCP client. Pi reaches MCP only through a plugin of the reader's
 * choosing, whose configuration the other client's steps show the shape of.
 */
export type Client = Exclude<Agent, "pi"> | "other";

/** Whether an agent is one of the clients offered. */
export function isClient(agent: Agent): agent is Exclude<Agent, "pi"> {
  return agent !== "pi";
}

/** The clients offered, in order: the agents Overwatch reads, then any other. */
export const CLIENTS: readonly Client[] = [...AGENTS.filter(isClient), "other"];

/** One thing to do to connect a client. */
export interface Step {
  /** What to do with `code`. */
  say: string;
  /** What to run or add, exactly. */
  code: string;
  /** What `code` is, for the name of the button that copies it. */
  kind: "command" | "configuration";
}

/** The name the server is registered under. */
const NAME = "overwatch";

/** A word of only these reads back from a shell as itself. */
const PLAIN = /^[A-Za-z0-9_./@%+=:,-]+$/;

/** A word as a POSIX shell reads it back unchanged. */
export function shellWord(word: string): string {
  return PLAIN.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The steps that connect `client` to `server`. */
export function steps(client: Client, server: McpServer): Step[] {
  const start = [server.command, ...server.args].map(shellWord).join(" ");
  const run = (command: string): Step => ({
    say: "Run this in a terminal:",
    code: command,
    kind: "command",
  });
  switch (client) {
    case "claude_code":
      return [run(`claude mcp add --scope user ${NAME} -- ${start}`)];
    case "codex":
      return [run(`codex mcp add ${NAME} -- ${start}`)];
    case "open_code":
      return [run(`opencode mcp add --global ${NAME} -- ${start}`)];
    case "grok_build":
      return [run(`grok mcp add ${NAME} -- ${start}`)];
    case "other":
      return [
        {
          say: "Add Overwatch to the client's MCP servers:",
          // The shape Claude Desktop set, which most clients read.
          code: JSON.stringify(
            { mcpServers: { [NAME]: { command: server.command, args: server.args } } },
            null,
            2,
          ),
          kind: "configuration",
        },
      ];
  }
}

/**
 * Whether the executable is a copy macOS runs an app from until it is moved:
 * one opened from a disk image, or still where it was downloaded, is
 * translocated to a path that goes away, and a command naming it with it.
 */
export function isTranslocated(command: string): boolean {
  return command.includes("/AppTranslocation/");
}
