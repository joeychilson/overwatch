/**
 * A made-up but plausible history of agent work, and the engine's answers about
 * it.
 *
 * Ninety days of sessions are drawn the same way each run, and every answer is
 * computed from them — the overview's days, the rankings, the session list and
 * its totals — so the pages agree with each other as they would on a real
 * machine. One session, the featured one, carries a whole conversation for the
 * session page.
 */
import type {
  Account,
  Agent,
  AgentDay,
  DayTotals,
  HourTotals,
  Filter,
  ModelSlice,
  ModelUsage,
  Overview,
  ProjectUsage,
  Session,
  SessionPage,
  Status,
  Tokens,
  Transcript,
} from "#lib/api/backend.ts";
import { AGENTS } from "#lib/api/backend.ts";
import { addDays, startOfDay } from "#lib/periods.ts";
import { MODEL, PROJECT, conversation, marks } from "./conversation.ts";
import { noise, pick } from "./random.ts";

/** The moment the pictures show: a Monday afternoon. */
export const NOW = new Date(2026, 8, 14, 16, 30).getTime();

/** How many days of history there are, today included. */
const DAYS = 90;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A time today. */
const today = (hours: number, minutes: number) => new Date(2026, 8, 14, hours, minutes).getTime();
/** Local midnight on the `index`th day of the history, today being the last. */
const dayAt = (index: number) => addDays(startOfDay(NOW), index - (DAYS - 1));

/**
 * What a million of a model's tokens costs once cache reads are counted at
 * their rate, or null for one with no listed price, and the days of the
 * history it was in use: new models arrive and old ones fall away.
 */
const MODELS: Record<string, { perMillion: number | null; from?: number; until?: number }> = {
  "claude-opus-5": { perMillion: 1.9, from: 58 },
  "claude-opus-4-8": { perMillion: 2.3, until: 64 },
  "claude-sonnet-5": { perMillion: 0.8 },
  "claude-haiku-4-5": { perMillion: 0.26 },
  "gpt-5.3-codex": { perMillion: 0.42, from: 40 },
  "gpt-5.2-codex": { perMillion: 0.45, until: 46 },
  "gpt-5.3-codex-spark": { perMillion: 0.16, from: 66 },
  "kimi-k2.6": { perMillion: 0.24 },
  "glm-5.1": { perMillion: 0.21, from: 30 },
  "qwen3.6-coder:30b": { perMillion: null },
  "gemini-3.8-flash": { perMillion: 0.09 },
  "grok-code-fast-1": { perMillion: 0.19 },
  "grok-5": { perMillion: 0.9, from: 52 },
};

/**
 * Each agent's habits: sessions on a usual weekday, tokens in a usual session,
 * the models its sessions run on and how often, a model a share of its work
 * goes through alongside, and what the runs it spawns are for.
 */
const HABITS: {
  agent: Agent;
  daily: number;
  size: number;
  models: [model: string, weight: number][];
  alongside?: [model: string, share: number];
  roles?: string[];
}[] = [
  {
    agent: "claude_code",
    daily: 6,
    size: 16e6,
    models: [
      ["claude-opus-5", 6],
      ["claude-opus-4-8", 6],
      ["claude-sonnet-5", 3],
    ],
    alongside: ["claude-haiku-4-5", 0.04],
    roles: ["explore", "general-purpose", "code-reviewer"],
  },
  {
    agent: "codex",
    daily: 7,
    size: 20e6,
    models: [
      ["gpt-5.3-codex", 6],
      ["gpt-5.2-codex", 6],
      ["gpt-5.3-codex-spark", 2],
    ],
    roles: ["guardian_review", "thread_spawn", "explorer"],
  },
  {
    agent: "open_code",
    daily: 2.5,
    size: 6e6,
    models: [
      ["kimi-k2.6", 4],
      ["glm-5.1", 3],
      ["qwen3.6-coder:30b", 2],
    ],
  },
  {
    agent: "pi",
    daily: 1.6,
    size: 5e6,
    models: [
      ["claude-sonnet-5", 4],
      ["gemini-3.8-flash", 3],
      ["gpt-5.3-codex", 2],
    ],
  },
  {
    agent: "grok_build",
    daily: 1.1,
    size: 4e6,
    models: [
      ["grok-code-fast-1", 3],
      ["grok-5", 2],
    ],
  },
];

/** Projects, how much of the work each gets, and what their sessions were about. */
const PROJECTS: [name: string, weight: number, titles: string[]][] = [
  [
    "ledger-api",
    26,
    [
      "Reconcile payouts against the bank export",
      "Fix rounding in multi-currency refunds",
      "Paginate the invoices endpoint with cursors",
      "Move webhook retries onto the jobs queue",
      "Why does the ledger balance drift by a cent",
      "Add a read replica for reporting queries",
      "Upgrade Drizzle and regenerate the migrations",
      "Rate limit the public API per key",
      "Write an ADR for splitting out payouts",
    ],
  ],
  [
    "overwatch",
    20,
    [
      "Rebuild the index instead of migrating it",
      "Draw the usage chart by hand in SVG",
      "Read Codex rollouts without loading them whole",
      "Price cache writes at the right rate",
      "Keep the menu bar figure on the tightest limit",
      "Count a model under one name across agents",
      "Page long conversations from the engine",
    ],
  ],
  [
    "field-notes",
    14,
    [
      "Find why WebKit drops the first keystroke",
      "Sync notes offline with a CRDT",
      "Add full-text search with SQLite FTS5",
      "Render Markdown tables in the editor",
      "Fix image paste on iOS Safari",
      "Debounce autosave without losing the last edit",
    ],
  ],
  [
    "infra",
    12,
    [
      "Move the staging cluster to Terraform modules",
      "Rotate database credentials with Vault",
      "Cache the Rust toolchain in CI",
      "Alert when the queue backlog passes five minutes",
      "Upgrade staging from Postgres 16 to 17",
      "Write a runbook for failing over the primary",
    ],
  ],
  [
    "pocket",
    10,
    [
      "Add Face ID unlock",
      "Fix chart jank on older Android phones",
      "Ship offline mode for the transactions list",
      "Localize the app into Spanish and German",
      "Crash on launch after the Expo upgrade",
    ],
  ],
  [
    "design-system",
    8,
    [
      "Build an accessible combobox",
      "Tokenize colours for dark mode",
      "Document the button variants in Storybook",
      "Replace the date picker with a native input",
    ],
  ],
  [
    "data-pipelines",
    5,
    [
      "Backfill daily revenue from the warehouse",
      "Dedupe events in the ingestion job",
      "Schedule the dbt models with Dagster",
    ],
  ],
  [
    "dotfiles",
    5,
    [
      "Set up Neovim LSP for Rust and TypeScript",
      "Show the Kubernetes context in the zsh prompt",
      "Script a fresh Mac setup with Homebrew Bundle",
    ],
  ],
];

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** Usage of a size, split the way agent work splits: mostly cache reads. */
function tokens(total: number): Tokens {
  return {
    input: Math.round(total * 0.06),
    output: Math.round(total * 0.015),
    cacheRead: Math.round(total * 0.9),
    cacheWrite: Math.round(total * 0.02),
    reasoning: Math.round(total * 0.005),
    total,
  };
}

/** A sum of costs that is null only when every part is. */
function cost(parts: readonly (number | null)[]): number | null {
  const priced = parts.filter((part) => part !== null);
  return priced.length === 0 ? null : sum(priced);
}

function slice(model: string, total: number): ModelSlice {
  const price = MODELS[model]?.perMillion ?? null;
  return { model, tokens: tokens(total), costUsd: price === null ? null : (total / 1e6) * price };
}

/** An item of `choices` in proportion to its weight. */
function weighted<T>(choices: readonly [T, number][], seed: number): T {
  let roll = noise(seed) * sum(choices.map(([, weight]) => weight));
  for (const [choice, weight] of choices) {
    roll -= weight;
    if (roll < 0) return choice;
  }
  const last = choices.at(-1);
  if (last === undefined) throw new Error("Cannot choose from nothing");
  return last[0];
}

/** An id shaped like the UUIDs agents name sessions with. */
function uuid(seed: number): string {
  const hex = Array.from({ length: 32 }, (_, digit) =>
    Math.floor(noise(seed * 31 + digit) * 16).toString(16),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function session(
  agent: Agent,
  nativeId: string,
  fields: Omit<
    Session,
    "id" | "agent" | "nativeId" | "tokens" | "costUsd" | "messages" | "tools" | "present"
  >,
): Session {
  const total = sum(fields.models.map((part) => part.tokens.total));
  return {
    id: `${agent}:${nativeId}`,
    agent,
    nativeId,
    ...fields,
    tokens: tokens(total),
    costUsd: cost(fields.models.map((part) => part.costUsd)),
    messages: null,
    tools: null,
    present: true,
  };
}

/** The featured session's afternoon, split by a break for lunch. */
const TURNS = conversation([
  [today(12, 58), today(14, 41)],
  [today(15, 22), today(16, 26)],
]);

/** The session the session page shows. */
export const FEATURED: Session = {
  ...session("claude_code", "5c1f7a2e-94d3-4b8e-a0f6-2d71c9e84b35", {
    title: "Add idempotency keys to the payment endpoints",
    cwd: PROJECT,
    branch: "feat/idempotency-keys",
    startedAt: today(12, 58),
    updatedAt: today(16, 26),
    spawned: false,
    role: null,
    models: [slice(MODEL, 139_406_220), slice("claude-haiku-4-5", 3_512_904)],
  }),
  messages: TURNS.filter((turn) => turn.speaker === "user" || turn.speaker === "assistant").length,
  tools: TURNS.filter((turn) => turn.speaker === "tool").length,
};

/** Every session of the history, spawned runs included. */
const SESSIONS: Session[] = (() => {
  const drawn: Session[] = [FEATURED];
  const told = new Map<string, number>();
  let seed = 1;
  let live = 0;
  for (let index = 0; index < DAYS; index += 1) {
    const day = dayAt(index);
    const weekend = [0, 6].includes(new Date(day).getDay());
    const growth = 0.65 + (0.35 * index) / (DAYS - 1);
    for (const habit of HABITS) {
      const count = Math.round(
        habit.daily * growth * (weekend ? 0.3 : 1) * (0.4 + 1.2 * noise((seed += 1))),
      );
      for (let made = 0; made < count; made += 1) {
        const models = habit.models.filter(([model]) => {
          const window = MODELS[model];
          return (window?.from ?? 0) <= index && index <= (window?.until ?? DAYS);
        });
        const [name, , titles] = weighted(
          PROJECTS.map((project) => [project, project[1]] as [(typeof PROJECTS)[number], number]),
          (seed += 1),
        );
        // Each project's titles in turn, so a day's rows do not repeat one.
        const order = told.get(name) ?? Math.floor(noise((seed += 1)) * titles.length);
        told.set(name, order + 1);
        const untitled = noise((seed += 1)) < 0.02;
        const title = untitled ? null : (titles[order % titles.length] ?? null);

        const draw = noise((seed += 1));
        const huge = noise((seed += 1)) > 0.985 ? 8 : 1;
        const total = Math.round(habit.size * (0.2 + 0.6 * draw + 3 * draw ** 4) * huge);
        const main = weighted(models, (seed += 1));
        const parts = [slice(main, total)];
        if (habit.alongside && noise((seed += 1)) < 0.4) {
          const [model, share] = habit.alongside;
          parts.push(slice(model, Math.round(total * share)));
        }

        const opens = weekend ? 10 + noise((seed += 1)) * 12 : 8.5 + noise((seed += 1)) * 11;
        const startedAt = day + opens * HOUR;
        let updatedAt = startedAt + (5 + 55 * (total / habit.size)) * MINUTE;
        if (startedAt > NOW - 10 * MINUTE) continue;
        // Work still going when the picture is taken ends just before it.
        if (updatedAt > NOW) updatedAt = NOW - (30 + 50 * live++) * 1000;

        const nativeId = uuid((seed += 1));
        const slug = (title ?? "wip").toLowerCase().split(" ").slice(0, 3).join("-");
        const branch = pick(["main", "main", `feat/${slug}`, `fix/${slug}`], (seed += 1));
        const parent = session(habit.agent, nativeId, {
          title,
          cwd: `/Users/me/Code/${name}`,
          branch,
          startedAt,
          updatedAt,
          spawned: false,
          role: null,
          models: parts,
        });
        drawn.push(parent);

        const children =
          habit.roles && noise((seed += 1)) < 0.35 ? 1 + Math.floor(noise((seed += 1)) * 2) : 0;
        for (let child = 0; child < children; child += 1) {
          const opened = startedAt + (updatedAt - startedAt) * noise((seed += 1)) * 0.7;
          drawn.push(
            session(habit.agent, uuid((seed += 1)), {
              title: null,
              cwd: parent.cwd,
              branch,
              startedAt: opened,
              updatedAt: opened + (updatedAt - opened) * 0.3,
              spawned: true,
              role: pick(habit.roles ?? [], (seed += 1)),
              models: [slice(main, Math.round(total * (0.05 + 0.2 * noise((seed += 1)))))],
            }),
          );
        }
      }
    }
  }
  return drawn;
})();

/**
 * Accounts of every subscription, in the states a busy week leaves them in, as
 * they stand at `now`.
 */
const accounts = (now: number): Account[] => [
  {
    id: "claude:me",
    provider: "claude",
    label: "me@example.com",
    plan: null,
    via: ["Claude Code"],
    limits: [
      {
        name: "5 hours",
        scope: null,
        usedPercent: 71,
        resetsAt: now + 108 * MINUTE,
        runsOutAt: now + 52 * MINUTE,
      },
      {
        name: "Weekly",
        scope: null,
        usedPercent: 46,
        resetsAt: now + 3 * 24 * HOUR,
        runsOutAt: null,
      },
      {
        name: "Weekly",
        scope: "Opus",
        usedPercent: 58,
        resetsAt: now + 3 * 24 * HOUR,
        runsOutAt: null,
      },
    ],
    readAt: now - 2 * MINUTE,
    problem: null,
    usedAt: now - 4 * MINUTE,
  },
  {
    id: "codex:me",
    provider: "codex",
    label: "me@example.com",
    plan: "pro",
    via: ["Codex", "Pi"],
    limits: [
      {
        name: "5 hours",
        scope: null,
        usedPercent: 23,
        resetsAt: now + 190 * MINUTE,
        runsOutAt: null,
      },
      {
        name: "Weekly",
        scope: null,
        usedPercent: 64,
        resetsAt: now + 4 * 24 * HOUR,
        runsOutAt: null,
      },
      {
        name: "Weekly",
        scope: "GPT-5.3-Codex-Spark",
        usedPercent: 12,
        resetsAt: now + 4 * 24 * HOUR,
        runsOutAt: null,
      },
    ],
    readAt: now - 3 * MINUTE,
    problem: null,
    usedAt: now - 12 * MINUTE,
  },
  {
    id: "open_code_go:me",
    provider: "open_code_go",
    label: null,
    plan: "Go",
    via: ["OpenCode", "Pi"],
    limits: [
      { name: "5 hours", scope: null, usedPercent: 8, resetsAt: now + 4 * HOUR, runsOutAt: null },
      {
        name: "Weekly",
        scope: null,
        usedPercent: 31,
        resetsAt: now + 5 * 24 * HOUR,
        runsOutAt: null,
      },
      {
        name: "Monthly",
        scope: null,
        usedPercent: 44,
        resetsAt: now + 16 * 24 * HOUR,
        runsOutAt: null,
      },
    ],
    readAt: now - 3 * MINUTE,
    problem: null,
    usedAt: now - 5 * HOUR,
  },
  {
    id: "claude:work",
    provider: "claude",
    label: "me@acme.dev",
    plan: null,
    via: ["Claude Code"],
    limits: [
      {
        name: "5 hours",
        scope: null,
        usedPercent: 88,
        resetsAt: now - 20 * MINUTE,
        runsOutAt: null,
      },
      {
        name: "Weekly",
        scope: null,
        usedPercent: 18,
        resetsAt: now + 6 * 24 * HOUR,
        runsOutAt: null,
      },
    ],
    readAt: now - 2 * MINUTE,
    problem: null,
    usedAt: now - 3 * HOUR,
  },
  {
    id: "grok:me",
    provider: "grok",
    label: "me@example.com",
    plan: null,
    via: ["Grok Build"],
    limits: [
      {
        name: "Weekly",
        scope: null,
        usedPercent: 38,
        resetsAt: now + 2 * 24 * HOUR,
        runsOutAt: null,
      },
    ],
    readAt: now - 2 * 24 * HOUR,
    problem: "sign_in",
    usedAt: now - 2 * 24 * HOUR,
  },
];

/** Sessions that began within a period, as the engine's usage totals count them. */
const within = (since = -Infinity, until = Infinity) =>
  SESSIONS.filter((each) => each.startedAt >= since && each.startedAt <= until);

function overview(since?: number, until?: number): Overview {
  const period = within(since, until);
  const days = new Map<number, Session[]>();
  for (const each of period) {
    const day = startOfDay(each.startedAt);
    days.set(day, [...(days.get(day) ?? []), each]);
  }
  const shares = (group: readonly Session[]) =>
    AGENTS.flatMap((agent) => {
      const own = group.filter((each) => each.agent === agent);
      return own.length === 0 ? [] : [{ agent, own }];
    });
  const daily: DayTotals[] = [...days]
    .sort(([a], [b]) => a - b)
    .map(([day, group]) => ({
      day,
      sessions: group.length,
      tokens: tokens(sum(group.map((each) => each.tokens.total))),
      costUsd: cost(group.map((each) => each.costUsd)),
      byAgent: shares(group).map(({ agent, own }): AgentDay => ({
        agent,
        tokens: sum(own.map((each) => each.tokens.total)),
        costUsd: cost(own.map((each) => each.costUsd)),
      })),
    }));
  return {
    sessions: period.length,
    tokens: tokens(sum(period.map((each) => each.tokens.total))),
    costUsd: cost(period.map((each) => each.costUsd)),
    byAgent: shares(period).map(({ agent, own }) => ({
      agent,
      sessions: own.length,
      tokens: tokens(sum(own.map((each) => each.tokens.total))),
      costUsd: cost(own.map((each) => each.costUsd)),
    })),
    daily,
  };
}

/** Each local hour's usage, where each session's falls when it began. */
function hours(since?: number, until?: number): HourTotals[] {
  const buckets = new Map<number, Session[]>();
  for (const each of within(since, until)) {
    const hour = new Date(each.startedAt);
    hour.setMinutes(0, 0, 0);
    buckets.set(hour.getTime(), [...(buckets.get(hour.getTime()) ?? []), each]);
  }
  return [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([hour, group]) => ({
      hour,
      sessions: group.length,
      tokens: tokens(sum(group.map((each) => each.tokens.total))),
      costUsd: cost(group.map((each) => each.costUsd)),
      byAgent: AGENTS.flatMap((agent) => {
        const own = group.filter((each) => each.agent === agent);
        return own.length === 0
          ? []
          : [
              {
                agent,
                tokens: sum(own.map((each) => each.tokens.total)),
                costUsd: cost(own.map((each) => each.costUsd)),
              },
            ];
      }),
    }));
}

function models(since?: number, until?: number): ModelUsage[] {
  const usage = new Map<string, ModelUsage>();
  for (const each of within(since, until)) {
    const day = startOfDay(each.startedAt);
    for (const part of each.models) {
      const known = usage.get(part.model) ?? {
        model: part.model,
        agents: [],
        sessions: 0,
        tokens: tokens(0),
        costUsd: null,
        daily: [],
      };
      const last = known.daily.at(-1);
      if (last?.day === day) {
        last.tokens += part.tokens.total;
        last.costUsd = cost([last.costUsd, part.costUsd]);
      } else {
        known.daily.push({ day, tokens: part.tokens.total, costUsd: part.costUsd });
      }
      usage.set(part.model, {
        ...known,
        agents: AGENTS.filter((agent) => agent === each.agent || known.agents.includes(agent)),
        sessions: known.sessions + 1,
        tokens: tokens(known.tokens.total + part.tokens.total),
        costUsd: cost([known.costUsd, part.costUsd]),
      });
    }
  }
  return [...usage.values()];
}

function projects(since?: number, until?: number): ProjectUsage[] {
  const usage = new Map<string, Session[]>();
  for (const each of within(since, until)) {
    if (each.cwd !== null) usage.set(each.cwd, [...(usage.get(each.cwd) ?? []), each]);
  }
  return [...usage].map(([project, group]) => ({
    project,
    sessions: group.length,
    tokens: tokens(sum(group.map((each) => each.tokens.total))),
    costUsd: cost(group.map((each) => each.costUsd)),
  }));
}

function list(filter: Filter): SessionPage {
  const search = filter.search?.toLowerCase();
  // A session's usage all falls where it began, so the period's sessions are
  // those that began in it, counted whole.
  const matched = within(filter.since ?? undefined, filter.until ?? undefined).filter(
    (each) =>
      (filter.includeSpawned || !each.spawned) &&
      (!filter.agents?.length || filter.agents.includes(each.agent)) &&
      (filter.project == null || each.cwd === filter.project) &&
      (filter.model == null || each.models.some((part) => part.model === filter.model)) &&
      (!search ||
        [each.title ?? "", each.cwd ?? "", ...each.models.map((part) => part.model)].some((text) =>
          text.toLowerCase().includes(search),
        )),
  );
  const { key, descending } = filter.sort ?? { key: "updated", descending: true };
  const measure = (each: Session) =>
    key === "started"
      ? each.startedAt
      : key === "tokens"
        ? each.tokens.total
        : key === "cost"
          ? (each.costUsd ?? -1)
          : each.updatedAt;
  matched.sort(
    (a, b) =>
      (descending ? -1 : 1) *
      (key === "title" ? (a.title ?? "").localeCompare(b.title ?? "") : measure(a) - measure(b)),
  );
  const offset = filter.offset ?? 0;
  return {
    sessions: matched.slice(offset, offset + (filter.limit ?? 100)),
    total: matched.length,
    tokens: tokens(sum(matched.map((each) => each.tokens.total))),
    costUsd: cost(matched.map((each) => each.costUsd)),
  };
}

function transcript(id: string, offset: number, limit: number): Transcript {
  const turns = id === FEATURED.id ? TURNS : [];
  return {
    sessionId: id,
    turns: turns.slice(offset, offset + limit),
    total: turns.length,
    messages: turns.filter((turn) => turn.speaker === "user" || turn.speaker === "assistant")
      .length,
    tools: turns.filter((turn) => turn.speaker === "tool").length,
  };
}

/**
 * What the engine reports about its own indexing.
 *
 * Read when asked rather than when this module loads: `vp run demo` puts this
 * module where the window reaches the engine, and the window's own engine
 * module is still being evaluated then, so `AGENTS` is not there yet. Every
 * command is answered later, by which time it is.
 */
const status = (now: number): Status => ({
  scanning: false,
  filesRead: 0,
  progress: null,
  sessions: SESSIONS.length,
  agents: [...AGENTS],
  problems: [],
  accounts: accounts(now),
});

const number = (value: unknown) => (typeof value === "number" ? value : undefined);

/**
 * What the engine would answer a command with, at `now`: the history's own
 * moment, or a later one that leaves the days since without any work.
 */
export function answer(command: string, args: Record<string, unknown>, now = NOW): unknown {
  const id = typeof args.id === "string" ? args.id : "";
  switch (command) {
    case "get_status":
      return status(now);
    case "get_overview":
      return overview(number(args.since), number(args.until));
    case "list_hours":
      return hours(number(args.since), number(args.until));
    case "list_models":
      return models(number(args.since), number(args.until));
    case "list_projects":
      return projects(number(args.since), number(args.until));
    case "list_sessions":
      return list((args.filter ?? {}) as Filter);
    case "get_session": {
      const found = SESSIONS.find((each) => each.id === id);
      if (!found) throw new Error(`No session ${id}`);
      return found;
    }
    case "get_timeline":
      return id === FEATURED.id ? marks(TURNS) : [];
    case "get_transcript":
      return transcript(id, number(args.offset) ?? 0, number(args.limit) ?? 150);
    case "search_conversations": {
      // Only the featured session has a conversation to look through.
      const sought = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const candidates = list({
        ...((args.filter ?? {}) as Filter),
        search: null,
        offset: 0,
        limit: SESSIONS.length,
      }).sessions;
      const said = TURNS.filter(
        (turn) =>
          (turn.speaker === "user" || turn.speaker === "assistant") &&
          sought !== "" &&
          turn.text.toLowerCase().includes(sought),
      );
      const first = said[0];
      if (first && candidates.some((each) => each.id === FEATURED.id)) {
        const words = first.text.split(/\s+/).join(" ");
        const at = Math.max(0, words.toLowerCase().indexOf(sought) - 48);
        const excerpt = `${at > 0 ? "…" : ""}${words.slice(at, at + 160)}${words.length > at + 160 ? "…" : ""}`;
        (args.found as { onmessage: (batch: unknown) => void }).onmessage([
          { session: FEATURED, turns: said.length, first: first.index, excerpt },
        ]);
      }
      return { searched: candidates.length, total: candidates.length, capped: false };
    }
    case "find_in_transcript": {
      const sought = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      if (sought === "" || id !== FEATURED.id) return [];
      return TURNS.filter((turn) =>
        [turn.text, turn.tool?.name, turn.tool?.input, turn.tool?.output].some((text) =>
          text?.toLowerCase().includes(sought),
        ),
      ).map((turn) => turn.index);
    }
    case "save_card":
      // Nothing is written here, so the answer is where the engine would have
      // put it: the Desktop, under the name the window asked for.
      return `/Users/you/Desktop/${typeof args.name === "string" ? args.name : "overwatch"}.png`;
    default:
      // Subscribing to the engine's events answers with a listener id.
      return 0;
  }
}
