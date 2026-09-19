/** How each agent is named, marked and resumed in the interface. */
import { AGENTS, type Agent, type Session } from "./api/backend.ts";
import type { MarkName } from "./components/marks/marks.ts";

export interface AgentDisplay {
  /** Name as it is written in the interface. */
  name: string;
  /** Brand mark. */
  mark: MarkName;
  /** What its share of a chart is drawn in, as a CSS colour. */
  color: string;
  /** The command that picks a session up again, given its id. */
  resume: (id: string) => string;
}

const DISPLAY: Record<Agent, AgentDisplay> = {
  claude_code: {
    name: "Claude Code",
    mark: "anthropic",
    color: "var(--agent-claude)",
    resume: (id) => `claude --resume ${id}`,
  },
  codex: {
    name: "Codex",
    mark: "openai",
    color: "var(--agent-codex)",
    resume: (id) => `codex resume ${id}`,
  },
  open_code: {
    name: "OpenCode",
    mark: "opencode",
    color: "var(--agent-opencode)",
    resume: (id) => `opencode --session ${id}`,
  },
  pi: { name: "Pi", mark: "pi", color: "var(--agent-pi)", resume: (id) => `pi --session ${id}` },
  grok_build: {
    name: "Grok",
    mark: "xai",
    color: "var(--agent-grok)",
    resume: (id) => `grok --resume ${id}`,
  },
};

/**
 * The shell command that picks a session up again, from the folder it ran in.
 *
 * A run an agent spawned for itself is not a conversation anyone returns to, so
 * it has none.
 */
export function resumeCommand(
  session: Pick<Session, "agent" | "nativeId" | "cwd" | "spawned">,
): string | null {
  if (session.spawned) return null;
  const command = DISPLAY[session.agent].resume(session.nativeId);
  return session.cwd === null ? command : `cd ${quote(session.cwd)} && ${command}`;
}

/** How recently a session must have been active to count as still going. */
const LIVE = 2 * 60_000;

/** Whether a session was active so recently that its agent is likely still at work. */
export function isLive(session: Pick<Session, "updatedAt">, now: number): boolean {
  return now - session.updatedAt < LIVE;
}

/** A value as a single shell word. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** How to show one agent. */
export function agentDisplay(agent: Agent): AgentDisplay {
  return DISPLAY[agent];
}

/** One agent's name. */
export function agentName(agent: Agent): string {
  return DISPLAY[agent].name;
}

/**
 * The agent a key names, or null when it names none.
 *
 * For keys that arrive untyped, such as from the address bar. The engine
 * rejects a filter naming an unknown agent outright, so one must never reach it.
 */
export function parseAgent(key: string | null): Agent | null {
  return AGENTS.find((agent) => agent === key) ?? null;
}

/**
 * A readable name for a spawned run's role.
 *
 * Agents name these themselves — `guardian_review`, `explore`, `thread_spawn` —
 * so the set is open and cannot be enumerated here.
 */
export function roleName(role: string | null): string {
  const spaced = (role ?? "").replaceAll(/[_-]/g, " ").trim();
  if (spaced === "") return "Agent run";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * What to call a session in a list: its title, or for a spawned run without
 * one what it was for. Its identifier, a UUID, would tell a reader nothing.
 */
export function sessionLabel(session: Pick<Session, "title" | "spawned" | "role">): string {
  if (session.title !== null && session.title.trim() !== "") return session.title;
  return session.spawned ? roleName(session.role) : "Untitled";
}
