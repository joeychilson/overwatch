/**
 * A scripted stand-in for Tauri's IPC boundary.
 *
 * In a plain browser every engine command rejects immediately, which hides all
 * of the asynchronous behaviour worth testing: initial versus subsequent
 * pending, overlapping requests, supersession, and retry after an error. These
 * helpers install a transport the test settles by hand, so the page code under
 * test is the real one and only the transport beneath it is controllable.
 * Nothing here is a seam in production code.
 */
import { expect, type Page } from "@playwright/test";

/** Shape the scripted transport exposes on `window`. */
export interface ScriptedIpc {
  calls: { id: number; cmd: string; args: Record<string, unknown> }[];
  settle(cmd: string, kind: "resolve" | "reject", value: unknown): number;
  /** Settle one call by its id, leaving any others of its command pending. */
  settleCall(id: number, kind: "resolve" | "reject", value: unknown): boolean;
  pendingCount(cmd: string): number;
  /** The calls of a command still waiting to be settled, oldest first. */
  pendingCalls(cmd: string): { id: number; args: Record<string, unknown> }[];
  /**
   * Deliver an event as the engine would: to every listener for it, or with a
   * `target` window, only to listeners for any window or for that one.
   */
  emit(event: string, payload: unknown, target?: string): number;
}

declare global {
  interface Window {
    __ipc: ScriptedIpc;
  }
}

/** Install the scripted transport before any page script runs. */
export async function installIpc(page: Page) {
  await page.addInitScript(() => {
    const pending = new Map<
      number,
      { cmd: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }
    >();
    const callbacks = new Map<number, (payload: unknown) => void>();
    /** The callback registered for each listened-to event, and the window it listens on. */
    const listeners: { event: string; handler: number; label: string | null }[] = [];
    /** The window this page stands for: the menu bar panel at `/tray`, else the app's. */
    const label = location.pathname.startsWith("/tray") ? "tray" : "main";
    const calls: { id: number; cmd: string; args: Record<string, unknown> }[] = [];
    let nextId = 1;

    window.__ipc = {
      calls,
      settle(cmd, kind, value) {
        let settled = 0;
        // Deleting the entry the loop is standing on is safe: a Map iterator
        // skips what has been removed and keeps its place otherwise.
        for (const [id, entry] of pending) {
          if (entry.cmd !== cmd) continue;
          pending.delete(id);
          if (kind === "resolve") entry.resolve(value);
          else entry.reject(value);
          settled += 1;
        }
        return settled;
      },
      settleCall(id, kind, value) {
        const entry = pending.get(id);
        if (!entry) return false;
        pending.delete(id);
        if (kind === "resolve") entry.resolve(value);
        else entry.reject(value);
        return true;
      },
      pendingCount(cmd) {
        let count = 0;
        for (const entry of pending.values()) if (entry.cmd === cmd) count += 1;
        return count;
      },
      pendingCalls(cmd) {
        return calls.filter((call) => call.cmd === cmd && pending.has(call.id));
      },
      emit(event, payload, target) {
        let delivered = 0;
        for (const listener of listeners) {
          const callback = callbacks.get(listener.handler);
          if (listener.event !== event || !callback) continue;
          // Tauri hands a listener for any window every event, sent to a window or not.
          if (target !== undefined && listener.label !== null && listener.label !== target) {
            continue;
          }
          callback({ event, id: 0, payload });
          delivered += 1;
        }
        return delivered;
      },
    };

    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
      invoke(cmd: string, args: Record<string, unknown>) {
        const id = nextId++;
        calls.push({ id, cmd, args: args ?? {} });
        // The event plugin's own commands answer immediately; only engine
        // commands are held open for the test to settle.
        if (cmd === "plugin:event|listen") {
          const target = args.target as { kind: string; label?: string };
          listeners.push({
            event: args.event as string,
            handler: args.handler as number,
            label: target.kind === "Any" ? null : (target.label ?? null),
          });
          return Promise.resolve(id);
        }
        if (cmd === "plugin:event|unlisten") return Promise.resolve(null);
        return new Promise((resolve, reject) => {
          pending.set(id, { cmd, resolve, reject });
        });
      },
      transformCallback(callback: (payload: unknown) => void) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
    };

    // `unlisten` calls into the event plugin's own globals before it reaches
    // the command, so a stand-in that omits them fails before recording
    // anything.
    (
      window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }
    ).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener() {},
    };
  });
}

/** Resolve a command's pending calls with `value`, once the page has made one. */
export async function settle(page: Page, cmd: string, value: unknown) {
  await expect
    .poll(() => page.evaluate((c) => window.__ipc.pendingCount(c), cmd))
    .toBeGreaterThan(0);
  await page.evaluate(([c, data]) => window.__ipc.settle(c as string, "resolve", data), [
    cmd,
    value,
  ] as const);
}

/** Deliver an engine event to the page, once it listens for it. */
export async function emit(page: Page, event: string, payload: unknown) {
  await expect
    .poll(() =>
      page.evaluate(([e, data]) => window.__ipc.emit(e as string, data), [event, payload] as const),
    )
    .toBeGreaterThan(0);
}

/**
 * Send an event to one window, as `emit_to` does, once the page listens for it,
 * answering how many of the page's listeners heard it.
 */
export async function emitTo(page: Page, target: string, event: string, payload: unknown) {
  await expect
    .poll(() =>
      page.evaluate(
        (e) =>
          window.__ipc.calls.some(
            (call) => call.cmd === "plugin:event|listen" && call.args.event === e,
          ),
        event,
      ),
    )
    .toBe(true);
  return page.evaluate(([e, data, t]) => window.__ipc.emit(e as string, data, t as string), [
    event,
    payload,
    target,
  ] as const);
}

/** A serialized engine failure. */
export function engineError(kind: string, message: string) {
  return { kind, message };
}

/** A token measurement, with a total that need not be the sum of its parts. */
export function tokens(total: number) {
  return {
    input: Math.round(total * 0.6),
    output: Math.round(total * 0.1),
    cacheRead: Math.round(total * 0.3),
    cacheWrite: 0,
    reasoning: 0,
    total,
  };
}

/** What a fixture row may vary from the default session. */
export interface SessionOverrides {
  agent?: string;
  spawned?: boolean;
  role?: string | null;
  title?: string | null;
  cwd?: string | null;
  models?: { model: string; tokens: ReturnType<typeof tokens>; costUsd: number | null }[];
  total?: number;
  costUsd?: number | null;
  messages?: number | null;
  tools?: number | null;
  present?: boolean;
  startedAt?: number;
  updatedAt?: number;
}

/** One session, enough for the list to render a row. */
export function session(id: string, title: string, overrides: SessionOverrides = {}) {
  const total = overrides.total ?? 15_000;
  return {
    id,
    agent: overrides.agent ?? "codex",
    nativeId: id,
    title: overrides.title === undefined ? title : overrides.title,
    cwd: overrides.cwd === undefined ? "/Users/me/Workspace/demo" : overrides.cwd,
    branch: null,
    startedAt: overrides.startedAt ?? 1_789_000_000_000,
    updatedAt: overrides.updatedAt ?? 1_789_000_600_000,
    spawned: overrides.spawned ?? false,
    role: overrides.role ?? null,
    models: overrides.models ?? [
      { model: "gpt-5-codex", tokens: tokens(total), costUsd: overrides.costUsd ?? null },
    ],
    tokens: tokens(total),
    costUsd: overrides.costUsd === undefined ? null : overrides.costUsd,
    messages: overrides.messages === undefined ? null : overrides.messages,
    tools: overrides.tools === undefined ? null : overrides.tools,
    present: overrides.present ?? true,
  };
}

/** A page of the session list. */
export function sessionPage(
  sessions: ReturnType<typeof session>[],
  options: { total?: number; costUsd?: number | null } = {},
) {
  const total = options.total ?? sessions.length;
  const summed = sessions.reduce((sum, row) => sum + row.tokens.total, 0);
  return {
    sessions,
    total,
    tokens: tokens(summed),
    costUsd: options.costUsd ?? null,
  };
}

/** One turn of a conversation. */
export function turn(
  index: number,
  speaker: "user" | "assistant" | "reasoning" | "tool" | "system",
  text: string,
  tool?: { name: string; input: string; output: string | null; failed?: boolean },
) {
  return {
    index,
    speaker,
    at: 1_789_000_000_000 + index * 1_000,
    model: speaker === "assistant" ? "gpt-5-codex" : null,
    text,
    tool: tool ? { failed: false, ...tool } : null,
  };
}

/** A window of a conversation. */
export function transcript(
  turns: ReturnType<typeof turn>[],
  options: { sessionId?: string; total?: number } = {},
) {
  return {
    sessionId: options.sessionId ?? "codex:ses_a",
    turns,
    total: options.total ?? turns.length,
    messages: turns.filter((t) => t.speaker === "user" || t.speaker === "assistant").length,
    tools: turns.filter((t) => t.speaker === "tool").length,
  };
}

/** Where each turn falls, as the engine's timeline reports it. */
export function marks(turns: ReturnType<typeof turn>[]) {
  return turns.map((each) => ({
    index: each.index,
    at: each.at,
    speaker: each.speaker,
    label: each.tool?.name ?? each.text.slice(0, 120),
    failed: each.tool?.failed ?? false,
  }));
}

/** What the engine reports about its own indexing. */
export function status(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    scanning: false,
    filesRead: 0,
    progress: null,
    sessions: 816,
    agents: ["claude_code", "codex"],
    problems: [],
    accounts: [],
    ...overrides,
  };
}

/** One model's share of recorded work. */
export function modelUsage(
  model: string,
  total: number,
  options: { sessions?: number; costUsd?: number | null; agents?: string[] } = {},
) {
  return {
    model,
    agents: options.agents ?? ["codex"],
    sessions: options.sessions ?? 3,
    tokens: tokens(total),
    costUsd: options.costUsd ?? null,
    daily: [],
  };
}

/** One project's share of recorded work. */
export function projectUsage(project: string, total: number, costUsd: number | null = null) {
  return { project, sessions: 2, tokens: tokens(total), costUsd };
}

/** Overview totals for yesterday and today, from one priced agent and one unpriced one. */
export function overview() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return {
    sessions: 3,
    tokens: tokens(3_000_000),
    costUsd: 12.5,
    byAgent: [
      { agent: "codex", sessions: 2, tokens: tokens(2_400_000), costUsd: 12.5 },
      { agent: "grok_build", sessions: 1, tokens: tokens(600_000), costUsd: null },
    ],
    daily: [
      {
        day: yesterday.getTime(),
        sessions: 2,
        tokens: tokens(2_500_000),
        costUsd: 2.5,
        byAgent: [
          { agent: "codex", tokens: 2_000_000, costUsd: 2.5 },
          { agent: "grok_build", tokens: 500_000, costUsd: null },
        ],
      },
      {
        day: today.getTime(),
        sessions: 1,
        tokens: tokens(500_000),
        costUsd: 10,
        byAgent: [
          { agent: "codex", tokens: 400_000, costUsd: 10 },
          { agent: "grok_build", tokens: 100_000, costUsd: null },
        ],
      },
    ],
  };
}

/** One subscription account, as the engine reports it. */
export function account(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "codex:workspace-1",
    provider: "codex",
    label: "joey@example.com",
    plan: "pro",
    via: ["Codex", "Pi"],
    limits: [
      // Far enough ahead that no test run sees these windows end.
      {
        name: "5 hours",
        scope: null,
        usedPercent: 42,
        resetsAt: 4_102_444_800_000,
        runsOutAt: null,
      },
      {
        name: "Weekly",
        scope: null,
        usedPercent: 56,
        resetsAt: 4_102_444_800_000,
        runsOutAt: null,
      },
    ],
    readAt: 1_789_000_600_000,
    problem: null,
    usedAt: null,
    ...overrides,
  };
}
