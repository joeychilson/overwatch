import type { Page } from "@playwright/test";
import type {
  Agent,
  Accounts,
  Preferences,
  Session,
  SessionEvent,
  Snapshot,
} from "../src/lib/bindings";
import { subDays } from "date-fns";

export async function captureRuntimeErrors(page: Page) {
  await page.addInitScript(() => {
    window.addEventListener("error", (event) => {
      const root = document.documentElement;
      root.dataset.runtimeErrors = JSON.stringify([
        ...JSON.parse(root.dataset.runtimeErrors ?? "[]"),
        event.message,
      ]);
    });
  });
}

const ids: Agent[] = ["codex", "claude", "opencode", "pi", "grok", "antigravity"];
const now = Date.now();
export const longNames = {
  session:
    "Investigate session indexing, usage accounting, and the behavior of concurrent coding agents. "
      .repeat(5)
      .trim(),
  model: "Example Reasoning Model With A Long Version And Variant Name ".repeat(6).trim(),
  provider: "Provider With A Very Long Display Name ".repeat(5).trim(),
  project: "a-project-with-a-long-name-".repeat(10),
  tool: `mcp__${"a_very_long_server_and_tool_name_".repeat(14)}lookup`,
};
const tokens = { input: 380000, cacheRead: 970000, cacheWrite: 0, output: 54000, reasoning: 12000 };
const catalog = {
  openai: {
    name: "OpenAI",
    models: {
      "gpt-6-astra": {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        description: "A capable model for complex coding tasks.",
        cost: { input: 10, output: 50, cache_read: 1 },
        limit: { context: 1050000, output: 128000 },
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text", "image"] },
        release_date: "2026-09-04",
      },
      "gpt-5.6-sol": {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        cost: { input: 3, output: 15, cache_read: 0.3 },
        limit: { context: 400000, output: 128000 },
        tool_call: true,
        release_date: "2026-08-01",
      },
    },
  },
  anthropic: {
    name: "Anthropic",
    models: {
      "claude-opus-5": {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 1000000, output: 128000 },
        reasoning: true,
        tool_call: true,
        release_date: "2026-07-24",
      },
    },
  },
};
const titles = [
  "Rebuild the session search experience",
  "Trace a slow query in the usage index",
  "Add keyboard navigation to the model table",
  "Review the streaming token parser",
  "Polish the settings and connections view",
  "Fix cache accounting across providers",
];
export const sessions: Session[] = Array.from({ length: 48 }, (_, index) => {
  const timestamp = subDays(now, Math.floor(index / 2)).getTime() - index * 180000;
  const agent = ids[index % 3];
  const model = agent === "claude" ? "claude-opus-5" : index % 2 ? "gpt-5.6-sol" : "gpt-6-astra";
  const ratio = 1 + (index % 5) * 0.2;
  const usageTokens = {
    ...tokens,
    input: Math.round(tokens.input * ratio),
    cacheRead: Math.round(tokens.cacheRead * ratio),
  };
  return {
    id: `session-${index}`,
    agent,
    title: titles[index % titles.length],
    cwd: index % 3 ? "/work/overwatch" : "/work/website",
    project: index % 3 ? "overwatch" : "website",
    model,
    startedAt: timestamp - 2800000,
    updatedAt: timestamp,
    messages: 18,
    turns: 9,
    compactions: index % 4 === 0 ? 1 : 0,
    tokens: usageTokens,
    usage: [
      {
        timestamp,
        model,
        provider: agent === "claude" ? "anthropic" : "openai",
        tokens: usageTokens,
        reportedCost: null,
      },
    ],
    tools: [
      {
        name: "exec_command",
        calls: 8 + (index % 8),
        failures: index % 5 === 0 ? 1 : 0,
        completed: 8 + (index % 8),
        timed: 8 + (index % 8),
        durationMs: 144000,
      },
      { name: "apply_patch", calls: 6, failures: 0, completed: 6, timed: 6, durationMs: 36000 },
      {
        name: "mcp__repo__search",
        calls: 4,
        failures: 0,
        completed: 4,
        timed: 4,
        durationMs: 12000,
      },
      { name: "read_file", calls: 3, failures: 0, completed: 3, timed: 3, durationMs: 1300 },
    ],
    limits: [],
    sourcePath: "/fixtures/session.jsonl",
    parentId: null,
    warnings: [],
  };
});
const transcript: SessionEvent[] = Array.from({ length: 20000 }, (_, index) => ({
  id: `event-${index}`,
  kind:
    index % 5 === 0
      ? "user"
      : index % 5 === 1
        ? "assistant"
        : index % 5 === 2
          ? "tool"
          : index % 5 === 3
            ? "thinking"
            : "compaction",
  timestamp: now - 20000000 + index * 1000,
  text:
    index === 0
      ? "Can you improve the session search?"
      : index === 1
        ? "I’ll check the parser and keep the results typed.\n\n```ts\nconst session = { title: 'Overwatch', ready: true };\n```\n\n![Remote](https://invalid.example/tracker.png)\n\n<script>window.injected = true</script>"
        : index === 19999
          ? "The final searchable needle"
          : index % 5 === 2
            ? '{"command":"rg session src"}'
            : "Recorded context for this session.",
  model: "gpt-6-astra",
  tool: index % 5 === 2 ? "exec_command" : null,
  output: index % 5 === 2 ? "src/session.ts\nProcess exited with code 0" : null,
  durationMs: index % 5 === 2 ? 600 : null,
  failed: index % 5 === 2 ? false : null,
}));

const previewTranscript: SessionEvent[] = [
  {
    tool: "exec_command",
    text: JSON.stringify({
      cmd: "rg 'useQuery|useVirtualizer' src --glob '*.tsx'",
      yield_time_ms: 1000,
    }),
    output: "src/lib/components/session-log.tsx\nProcess exited with code 0",
    failed: false,
  },
  {
    tool: "Read",
    text: JSON.stringify({
      file_path: "/work/website/src/lib/components/session-log.tsx",
      offset: 120,
      limit: 61,
    }),
    output: "120: export function SessionLog() {\n121:   return <div />;\n122: }",
    failed: false,
  },
  {
    tool: "apply_patch",
    text: "*** Begin Patch\n*** Update File: src/lib/components/session-log.tsx\n@@\n-old\n+new\n*** Add File: src/lib/tool-preview.ts\n+export {};\n*** End Patch",
    output: "Success. Updated 2 files.",
    failed: false,
  },
  {
    tool: "Grep",
    text: JSON.stringify({ pattern: "eventPageOptions", path: "/work/website/src" }),
    output: "src/lib/components/session-log.tsx:32",
    failed: false,
  },
  {
    tool: "Bash",
    text: JSON.stringify({ command: "vp test run" }),
    output:
      "Starting tests\nError: Cannot find module './tool-preview'\nProcess exited with code 1",
    failed: true,
  },
  {
    tool: "Edit",
    text: JSON.stringify({
      file_path: "src/app.tsx",
      new_string: `${"replacement ".repeat(4000)}[deep-match] end`,
    }),
    output: "Updated src/app.tsx",
    failed: false,
  },
  {
    tool: "custom_lookup",
    text: "a raw input\nwith a second line",
    output: `${"result ".repeat(5000)}output-needle was found`,
    failed: false,
  },
  { tool: "pending_tool", text: "{}", output: null, failed: null },
].map((event, index) => ({
  ...event,
  id: `preview-${index}`,
  kind: "tool",
  timestamp: now + index * 1000,
  model: "gpt-6-astra",
  durationMs: event.output ? 600 : null,
}));

export async function desktop(
  page: Page,
  options: {
    failRefresh?: boolean;
    failSave?: boolean;
    invalidCatalog?: boolean;
    failEventsAt?: number;
    emptyTranscript?: boolean;
    toolPreviews?: boolean;
    quotaState?: "collecting" | "stale" | "expired";
    singleAllowance?: boolean;
    longNames?: boolean;
    crossProvider?: boolean;
    manyModels?: boolean;
    periodMismatch?: boolean;
    cachedSummaryIssue?: boolean;
    undatedUsage?: boolean;
    undatedEvents?: "all" | "mixed";
    costCoverage?: "unknown" | "zero" | "mixed";
  } = {},
) {
  const snapshot: Snapshot = {
    sessions: options.longNames
      ? sessions.map((session, index) =>
          index === 40
            ? {
                ...session,
                title: longNames.session,
                model: longNames.model,
                project: longNames.project,
                cwd: `/work/${longNames.project}`,
                tools: [
                  ...session.tools,
                  {
                    name: longNames.tool,
                    calls: 1,
                    failures: 0,
                    completed: 1,
                    timed: 1,
                    durationMs: 1000,
                  },
                ],
              }
            : session,
        )
      : sessions,
    sources: ids.map((agent) => ({
      source: { agent, path: `/fixtures/${agent}`, enabled: agent !== "antigravity" },
      available: agent !== "antigravity",
      sessions: sessions.filter((session) => session.agent === agent).length,
      issues: [],
    })),
    indexedAt: now,
    scanning: false,
  };
  if (options.cachedSummaryIssue) {
    snapshot.sources[0].issues = [
      "An unreadable cached session is excluded from totals: /fixtures/codex/damaged.jsonl. Rescan sources to rebuild it from the original history.",
    ];
  }
  if (options.undatedUsage) {
    snapshot.sessions = [
      {
        ...sessions[0],
        usage: sessions[0].usage.map((usage) => ({ ...usage, timestamp: 0 })),
      },
    ];
  }
  if (options.undatedEvents) {
    snapshot.sessions = [{ ...sessions[0], startedAt: 0, updatedAt: 0 }];
  }
  if (options.periodMismatch) {
    snapshot.sessions = sessions.slice(0, 2).map((session, index) => ({
      ...session,
      updatedAt: index === 0 ? now - 60 * 86400000 : now,
      usage: session.usage.map((usage) => ({
        ...usage,
        timestamp: index === 0 ? now - 3600000 : now - 60 * 86400000,
      })),
    }));
  }
  if (options.manyModels) {
    snapshot.sessions = Array.from({ length: 80 }, (_, index) => ({
      ...sessions[0],
      id: `many-models-${index}`,
      usage: [
        {
          ...sessions[0].usage[0],
          timestamp: now - 3600000,
          provider: "custom",
          model: `fixture-model-${String(index).padStart(3, "0")}`,
          tokens: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          reportedCost: null,
        },
      ],
    }));
  }
  if (options.crossProvider) {
    snapshot.sessions = sessions.slice(0, 3).map((session, index) => ({
      ...session,
      agent: (["codex", "pi", "opencode"] as const)[index],
      usage: [
        {
          ...session.usage[0],
          timestamp: now - 3600000,
          provider: ["openai", "azure", "openrouter"][index],
          model: index === 2 ? "openai/gpt-6-astra" : "gpt-6-astra",
          tokens: {
            input: (index + 1) * 1_000_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
          },
          reportedCost: null,
        },
      ],
    }));
  }
  if (options.costCoverage) {
    snapshot.sessions = snapshot.sessions.map((session, index) => ({
      ...session,
      usage: session.usage.map((usage) => ({
        ...usage,
        provider:
          options.costCoverage === "unknown" ||
          (options.costCoverage === "mixed" && index % 3 === 0)
            ? "unlisted-provider"
            : usage.provider,
        reportedCost:
          options.costCoverage === "zero"
            ? 0
            : options.costCoverage === "mixed" && index % 3 === 1
              ? 2
              : null,
      })),
    }));
  }
  const readingTime =
    options.quotaState === "stale" || options.quotaState === "expired" ? now - 1_800_000 : now;
  const samples = (options.quotaState === "collecting" ? [2] : [0, 1, 2]).map((index) => ({
    agent: "codex" as const,
    accountKey: "fixture-account",
    bucket: "codex:primary",
    label: "5 hour",
    usedPercent: 28 + index * 7,
    windowMinutes: 300,
    resetsAt: options.quotaState === "expired" ? now - 60_000 : now + 3600000,
    timestamp: readingTime - (2 - index) * 900000,
    source: "OpenAI account",
  }));
  const weekly = (options.quotaState === "collecting" ? [6] : [0, 1, 2, 3, 4, 5, 6]).map(
    (index) => ({
      ...samples[0],
      bucket: "codex:secondary",
      label: "Weekly",
      windowMinutes: 10080,
      usedPercent: options.quotaState === "collecting" ? 0 : 35 + index * 3.5,
      resetsAt: options.quotaState === "expired" ? now - 60_000 : now + 6 * 86400000,
      timestamp: readingTime - (6 - index) * 1200000,
    }),
  );
  const accounts: Accounts = {
    accounts: [
      {
        agent: "codex",
        usage: {
          accountKey: "fixture-account",
          plan: "Pro",
          updatedAt: readingTime,
          source: "OpenAI account",
          windows: options.singleAllowance
            ? [weekly[weekly.length - 1]]
            : [samples[samples.length - 1], weekly[weekly.length - 1]],
          balances: [
            {
              label: "Credits",
              used: null,
              limit: null,
              remaining: 240,
              unit: "credits",
              unlimited: false,
            },
          ],
        },
        error: null,
        lastAttempt: now,
        nextRefreshAt: now + 300000,
      },
    ],
    samples: [...samples, ...weekly],
  };
  const preferences: Preferences = { theme: "dark", savedModels: [], sidebarCollapsed: false };
  await page.addInitScript(
    ({ snapshot, catalog, transcript, previewTranscript, accounts, preferences, options, now }) => {
      const state = { snapshot, accounts, preferences };
      const recorded = options.emptyTranscript
        ? []
        : options.toolPreviews
          ? previewTranscript
          : options.undatedEvents
            ? transcript.map((event, index) => ({
                ...event,
                timestamp: options.undatedEvents === "all" || index === 0 ? 0 : event.timestamp,
              }))
            : transcript;
      let failedEventRequests = 0;
      const callbacks = new Map<number, (value: unknown) => void>();
      let sequence = 0;
      const listeners = new Map<string, number[]>();
      const emit = (event: string) => {
        for (const callback of listeners.get(event) ?? [])
          callbacks.get(callback)?.({ event, payload: null });
      };
      Object.defineProperty(window, "isTauri", { value: true });
      Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
        value: { unregisterListener: () => {} },
      });
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        value: {
          transformCallback: (callback: (value: unknown) => void) => {
            callbacks.set(++sequence, callback);
            return sequence;
          },
          unregisterCallback: (id: number) => callbacks.delete(id),
          invoke: async (command: string, args: Record<string, unknown> = {}) => {
            switch (command) {
              case "get_snapshot":
                return state.snapshot;
              case "refresh_index":
                if (options.failRefresh) throw { kind: "io", message: "Fixture disk read failed" };
                if (options.cachedSummaryIssue) state.snapshot.sources[0].issues = [];
                return structuredClone(state.snapshot);
              case "get_preferences":
                return state.preferences;
              case "save_preferences":
                state.preferences = args.preferences as Preferences;
                return state.preferences;
              case "get_catalog":
                return {
                  json: JSON.stringify(
                    options.invalidCatalog && args.request !== "bundled"
                      ? {
                          lab: {
                            name: "Broken provider",
                            models: {
                              broken: { id: "broken", name: "Broken model", cost: { input: -5 } },
                            },
                          },
                        }
                      : catalog,
                  ),
                  updatedAt: now,
                  source: args.request === "bundled" ? "bundled" : "cached",
                  warning: null,
                };
              case "get_transcript":
                return {
                  session: state.snapshot.sessions.find((session) => session.id === args.id),
                  timeline: recorded.map((event, index) => ({
                    index,
                    kind: event.kind,
                    timestamp: event.timestamp,
                    durationMs: event.durationMs,
                    tool: event.tool,
                    failed: event.failed,
                  })),
                };
              case "get_events": {
                if (args.offset === options.failEventsAt && ++failedEventRequests <= 2)
                  throw { kind: "io", message: "Fixture transcript read failed" };
                const query = (typeof args.search === "string" ? args.search : "").toLowerCase();
                const matches = recorded.flatMap((event, index) =>
                  !query ||
                  `${event.tool ?? ""} ${event.text} ${event.output ?? ""}`
                    .toLowerCase()
                    .includes(query)
                    ? [index]
                    : [],
                );
                const offset = Math.min(
                  Number(args.offset),
                  Math.floor(Math.max(0, matches.length - 1) / 100) * 100,
                );
                return {
                  events: matches.slice(offset, offset + 100).map((index) => recorded[index]),
                  offset,
                  total: matches.length,
                  matches: query ? matches.slice(offset, offset + 100) : [],
                };
              }
              case "get_accounts":
                return state.accounts;
              case "refresh_account": {
                const account = state.accounts.accounts.find(
                  (account) => account.agent === args.agent,
                ) ?? { ...state.accounts.accounts[0], agent: args.agent as Agent };
                if (options.failRefresh)
                  account.error = { kind: "network", message: "Fixture provider unavailable" };
                else account.error = null;
                state.accounts.accounts = [
                  ...state.accounts.accounts.filter((item) => item.agent !== account.agent),
                  account,
                ];
                emit("accounts-changed");
                return account;
              }
              case "save_sources":
                if (options.failSave)
                  throw { kind: "io", message: "Fixture settings write failed" };
                state.snapshot.sources = state.snapshot.sources.map((status) => ({
                  ...status,
                  source:
                    (args.sources as Snapshot["sources"][number]["source"][]).find(
                      (source) => source.agent === status.source.agent,
                    ) ?? status.source,
                }));
                return state.snapshot;
              case "save_catalog":
                return null;
              case "save_token":
                if (args.token == null) {
                  state.accounts.accounts = state.accounts.accounts.filter(
                    (account) => account.agent !== args.agent,
                  );
                  state.accounts.samples = state.accounts.samples.filter(
                    (sample) => sample.agent !== args.agent,
                  );
                }
                return null;
              case "export_file":
              case "export_session":
                return true;
              case "open_session_source":
                document.documentElement.dataset.openedSessionSource = String(args.id);
                return null;
              case "plugin:dialog|open":
                return "/fixtures/chosen";
              case "plugin:opener|open_url":
                return null;
              case "plugin:event|listen": {
                const event = String(args.event);
                listeners.set(event, [...(listeners.get(event) ?? []), Number(args.handler)]);
                return args.handler;
              }
              case "plugin:event|unlisten":
                return null;
              default:
                throw new Error(`Unhandled fixture command: ${command}`);
            }
          },
        },
      });
    },
    {
      snapshot,
      catalog: options.crossProvider
        ? {
            ...catalog,
            azure: {
              name: "Azure",
              models: {
                "gpt-6-astra": { ...catalog.openai.models["gpt-6-astra"], cost: { input: 20 } },
              },
            },
            openrouter: {
              name: "OpenRouter",
              models: {
                "openai/gpt-6-astra": {
                  ...catalog.openai.models["gpt-6-astra"],
                  cost: { input: 30 },
                },
              },
            },
          }
        : options.longNames
          ? {
              ...catalog,
              example: {
                name: longNames.provider,
                models: {
                  "long-model": {
                    ...catalog.openai.models["gpt-6-astra"],
                    id: "long-model",
                    name: longNames.model,
                  },
                },
              },
            }
          : catalog,
      transcript,
      previewTranscript,
      accounts,
      preferences,
      options,
      now,
    },
  );
}
