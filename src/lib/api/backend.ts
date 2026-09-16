/**
 * The engine's command surface.
 *
 * Every type here is written by hand and mirrors a Rust type in
 * `src-tauri/src/session.rs` one to one. There are fourteen commands and about
 * two dozen shapes, which is small enough to keep honest by reading.
 *
 * Counts and money are plain numbers. The largest total any agent records is a
 * few billion tokens, which JavaScript represents exactly, so nothing here
 * parses a decimal string.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A coding agent whose history the engine reads. */
export type Agent = "claude_code" | "codex" | "open_code" | "pi" | "grok_build";

/** Every agent, in the order the interface offers them. */
export const AGENTS: readonly Agent[] = ["claude_code", "codex", "open_code", "pi", "grok_build"];

/** Tokens a session consumed, as its own agent accounted for them. */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** The agent's own total, never recomputed from the parts above. */
  total: number;
}

/** One model's share of a session. */
export interface ModelSlice {
  model: string;
  tokens: Tokens;
  /** Null when its model has no listed price. */
  costUsd: number | null;
}

/** One session, as the list and its own page show it. */
export interface Session {
  /** Stable application id, `agent:nativeId`. */
  id: string;
  agent: Agent;
  nativeId: string;
  /** Null when the session has no prompt or generated name yet. */
  title: string | null;
  cwd: string | null;
  branch: string | null;
  /** Unix milliseconds. */
  startedAt: number;
  /** Unix milliseconds. */
  updatedAt: number;
  /** Whether an agent started this run rather than a person. */
  spawned: boolean;
  /** What a spawned run was for, in the agent's own words. */
  role: string | null;
  models: ModelSlice[];
  tokens: Tokens;
  /**
   * Cost at list prices, or null when none of its usage has a price. A null
   * here means unknown, not zero.
   */
  costUsd: number | null;
  /** Null until the conversation has been read in full. */
  messages: number | null;
  /** Null until the conversation has been read in full. */
  tools: number | null;
  /** Whether the file this session came from is still on disk. */
  present: boolean;
}

/** Who produced one part of a conversation. */
export type Speaker = "user" | "assistant" | "reasoning" | "tool" | "system";

/** One tool call, with its result already in hand. */
export interface ToolCall {
  name: string;
  input: string;
  output: string | null;
  failed: boolean;
}

/** One readable part of a conversation. */
export interface Turn {
  index: number;
  speaker: Speaker;
  at: number | null;
  model: string | null;
  text: string;
  tool: ToolCall | null;
}

/** A window of a session's conversation. */
export interface Transcript {
  sessionId: string;
  /** The requested window, in source order. */
  turns: Turn[];
  /** How many readable turns the whole session has. */
  total: number;
  messages: number;
  tools: number;
}

/** Where one turn falls in its session, for the session's timeline. */
export interface Mark {
  index: number;
  /** Null where the source records no time per message. */
  at: number | null;
  speaker: Speaker;
  /** The opening of what was said, or the tool's name; empty for thinking. */
  label: string;
  failed: boolean;
}

/** A column the session list can be ordered by. */
export type SortKey = "updated" | "started" | "tokens" | "cost" | "title";

export interface Sort {
  key: SortKey;
  descending: boolean;
}

/**
 * How a caller narrows the session list.
 *
 * Every field is optional and an omitted field filters nothing. There is no
 * view to open and nothing to release afterwards: this is answered afresh each
 * time it is sent.
 *
 * A period, from `since` or `until`, also changes what each session counts: its
 * tokens, cost and models are only what it used inside the period, and the list
 * is ordered and totalled by those.
 */
export interface Filter {
  search?: string | null;
  agents?: Agent[];
  includeSpawned?: boolean;
  /**
   * Only sessions that used tokens at or after this instant, counting only what
   * they used from then.
   */
  since?: number | null;
  /**
   * Only sessions that used tokens at or before this instant, counting only
   * what they used until then.
   */
  until?: number | null;
  /** Only sessions that worked in this directory, matched whole. */
  project?: string | null;
  /** Only sessions that used this model, matched whole. */
  model?: string | null;
  sort?: Sort;
  offset?: number;
  limit?: number;
}

/** A page of the session list, with the totals of the whole match. */
export interface SessionPage {
  sessions: Session[];
  /** How many sessions match, ignoring the page window. */
  total: number;
  /** Tokens across every match, not only this page. */
  tokens: Tokens;
  /** Null when none of the match has a price. */
  costUsd: number | null;
}

/** One model's share of recorded work. */
export interface ModelUsage {
  model: string;
  agents: Agent[];
  sessions: number;
  tokens: Tokens;
  /** Null when the model has no listed price. */
  costUsd: number | null;
  /** Its usage on each local day of the period it was used, oldest first. */
  daily: ModelDay[];
}

/** One model's usage on one local day. */
export interface ModelDay {
  /** Local midnight at the start of the day. */
  day: number;
  tokens: number;
  /** Null when the model has no listed price. */
  costUsd: number | null;
}

/** One project's share of recorded work, a project being the directory its sessions worked in. */
export interface ProjectUsage {
  project: string;
  sessions: number;
  tokens: Tokens;
  /** Null when none of its usage has a price. */
  costUsd: number | null;
}

/** Why a subscription's limits could not be refreshed. */
export type Problem = "sign_in" | "unavailable" | "unrecognized";

/** One usage limit of a subscription. */
export interface Limit {
  /** The window it covers, such as `5 hours` or `Weekly`. */
  name: string;
  /** The one model it applies to, such as `Opus`; null when it covers all usage. */
  scope: string | null;
  /** How much has been used, from 0; above 100 once exceeded. */
  usedPercent: number;
  resetsAt: number | null;
  /** When it runs out at the recent rate of use, if that is before it resets. */
  runsOutAt: number | null;
}

/** A subscription whose limits the engine reads, whichever agent holds it. */
export type Provider = "claude" | "codex" | "grok" | "open_code_go";

/**
 * One account of a subscription, with its limits as the provider last reported
 * them.
 *
 * When the latest attempt failed, `problem` says why and the limits are the
 * last ones read successfully, as of `readAt`.
 */
export interface Account {
  /** Stable across launches. */
  id: string;
  provider: Provider;
  /** Tells accounts of one subscription apart, such as an email address. */
  label: string | null;
  plan: string | null;
  /** The apps holding a sign-in to the account. */
  via: string[];
  limits: Limit[];
  /** Null until a read has succeeded. */
  readAt: number | null;
  problem: Problem | null;
  /**
   * When it was last seen in use: by a session on this machine, or by its
   * limits rising between reads, wherever it was used from.
   */
  usedAt: number | null;
}

export interface AgentTotals {
  agent: Agent;
  sessions: number;
  tokens: Tokens;
  /** Null when none of its usage has a price. */
  costUsd: number | null;
}

export interface DayTotals {
  /** Local midnight at the start of the day. */
  day: number;
  sessions: number;
  tokens: Tokens;
  /** Null when none of that day's usage has a price. */
  costUsd: number | null;
  byAgent: AgentDay[];
}

/** One agent's share of a day. */
export interface AgentDay {
  agent: Agent;
  tokens: number;
  /** Null when none of its usage that day has a price. */
  costUsd: number | null;
}

/** Totals for the overview over a requested period. */
export interface Overview {
  sessions: number;
  tokens: Tokens;
  /** Null when none of the period's usage has a price. */
  costUsd: number | null;
  byAgent: AgentTotals[];
  daily: DayTotals[];
}

/** What the engine knows so far: how indexing went, and each subscription's limits. */
export interface Status {
  scanning: boolean;
  filesRead: number;
  /** How far a long scan has got: files read, and files to read. */
  progress: [number, number] | null;
  sessions: number;
  agents: Agent[];
  problems: string[];
  accounts: Account[];
}

/** What a failed command rejects with. */
export interface EngineError {
  kind:
    | "not_found"
    | "read_failed"
    | "write_failed"
    | "store_failed"
    | "open_failed"
    | "invalid"
    | "unavailable";
  message: string;
}

/** Whether a rejected value is one of the engine's errors. */
export function isEngineError(value: unknown): value is EngineError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EngineError>;
  return typeof candidate.kind === "string" && typeof candidate.message === "string";
}

async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (isEngineError(error)) throw error;
    // Outside Tauri — browser development and the Playwright suite — `invoke`
    // itself fails, which is a different thing from the engine refusing.
    throw {
      kind: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    } satisfies EngineError;
  }
}

/** One page of the session list, with the totals of the whole match. */
export function listSessions(filter: Filter = {}): Promise<SessionPage> {
  return call<SessionPage>("list_sessions", { filter });
}

/** One session's summary. */
export function getSession(id: string): Promise<Session> {
  return call<Session>("get_session", { id });
}

/**
 * A window of one session's conversation.
 *
 * `offset` counts readable turns. The engine parses the conversation once and
 * holds it, so paging through a long session costs nothing further.
 */
export function getTranscript(id: string, offset = 0, limit = 200): Promise<Transcript> {
  return call<Transcript>("get_transcript", { id, offset, limit });
}

/** Where every turn of a session falls, however long it is. */
export function getTimeline(id: string): Promise<Mark[]> {
  return call<Mark[]>("get_timeline", { id });
}

/** Release the held conversation when the reader leaves it. */
export function closeTranscript(): Promise<void> {
  return call<void>("close_transcript");
}

/** Show the file a session's history is in, in Finder. */
export function revealSession(id: string): Promise<void> {
  return call<void>("reveal_session", { id });
}

/** Open the folder a session worked in. */
export function openSessionFolder(id: string): Promise<void> {
  return call<void>("open_session_folder", { id });
}

/** Models ranked by recorded usage over a period. */
export function listModels(since?: number, until?: number): Promise<ModelUsage[]> {
  return call<ModelUsage[]>("list_models", { since, until });
}

/** Projects ranked by recorded usage over a period. */
export function listProjects(since?: number, until?: number): Promise<ProjectUsage[]> {
  return call<ProjectUsage[]>("list_projects", { since, until });
}

/** Totals for the overview, with days that break at local midnight. */
export function getOverview(since?: number, until?: number): Promise<Overview> {
  return call<Overview>("get_overview", { since, until });
}

/** What indexing has done so far. Never waits for a scan. */
export function getStatus(): Promise<Status> {
  return call<Status>("get_status");
}

/**
 * Write a picture the window drew to the Desktop, and answer with where it
 * went.
 *
 * `name` has no extension: the engine gives it one, and a name already taken
 * gets a number rather than overwriting what is there. `png` is the image's
 * bytes in base64, which is what a canvas's data URL already carries.
 */
export function saveCard(name: string, png: string): Promise<string> {
  return call<string>("save_card", { name, png });
}

/** Bring the app's window forward, at a destination such as `/subscriptions` when one is given. */
export function openWindow(path?: string): Promise<void> {
  return call<void>("open_window", { path });
}

/** Quit the app, and with it the menu bar item. */
export function quit(): Promise<void> {
  return call<void>("quit");
}

/**
 * Subscribe to the app's menu asking the window to show a destination, such as
 * `/subscriptions`.
 *
 * Resolves to an unlisten function, as {@link onIndexChanged} does.
 */
export async function onOpen(handler: (path: string) => void): Promise<UnlistenFn> {
  try {
    return await listen<string>("open", (event) => handler(event.payload));
  } catch {
    return () => {};
  }
}

/**
 * Subscribe to the engine's "the index changed" notice.
 *
 * Resolves to an unlisten function the caller must invoke on teardown. Outside
 * Tauri the subscription never establishes and the teardown is a no-op.
 */
export async function onIndexChanged(handler: (status: Status) => void): Promise<UnlistenFn> {
  try {
    return await listen<Status>("index_changed", (event) => handler(event.payload));
  } catch {
    return () => {};
  }
}
