import { expect, test } from "vite-plus/test";
import { card } from "./card.ts";
import type { Agent, AgentDay, ModelUsage, Overview, Tokens } from "./api/backend.ts";

/** How `Intl` joins the ends of a date range: an en dash between thin spaces. */
const TO = "\u2009\u2013\u2009";

const NOW = new Date(2026, 8, 16, 14, 30);

function tokens(total: number): Tokens {
  return { input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total };
}

function day(back: number, shares: AgentDay[]): Overview["daily"][number] {
  const at = new Date(NOW);
  at.setHours(0, 0, 0, 0);
  at.setDate(at.getDate() - back);
  const total = shares.reduce((sum, share) => sum + share.tokens, 0);
  return {
    day: at.getTime(),
    sessions: 1,
    tokens: tokens(total),
    costUsd: shares.reduce<number | null>(
      (sum, share) => (share.costUsd === null ? sum : (sum ?? 0) + share.costUsd),
      null,
    ),
    byAgent: shares,
  };
}

function overview(options: Partial<Overview> = {}): Overview {
  return {
    sessions: 12,
    tokens: tokens(3_000_000),
    costUsd: 24.5,
    byAgent: [
      { agent: "claude_code", sessions: 8, tokens: tokens(2_000_000), costUsd: 20 },
      { agent: "codex", sessions: 4, tokens: tokens(1_000_000), costUsd: 4.5 },
    ],
    daily: [
      day(1, [
        { agent: "claude_code", tokens: 1_500_000, costUsd: 15 },
        { agent: "codex", tokens: 500_000, costUsd: 2.5 },
      ]),
      day(0, [
        { agent: "claude_code", tokens: 500_000, costUsd: 5 },
        { agent: "codex", tokens: 500_000, costUsd: 2 },
      ]),
    ],
    ...options,
  };
}

function model(name: string, total: number, costUsd: number | null, agent: Agent): ModelUsage {
  return { model: name, agents: [agent], sessions: 3, tokens: tokens(total), costUsd, daily: [] };
}

const MODELS = [
  model("claude-opus-4-1", 2_000_000, 20, "claude_code"),
  model("gpt-5-codex", 1_000_000, 4.5, "codex"),
];

test("the headline is the measure the overview is showing", () => {
  const byTokens = card({
    overview: overview(),
    models: MODELS,
    days: 7,
    measure: "tokens",
    now: NOW,
  });
  expect(byTokens.figures[0]).toEqual({ label: "Tokens", value: "3.0M" });
  expect(byTokens.figures.map((figure) => figure.label)).toEqual([
    "Tokens",
    "Estimated cost",
    "Sessions",
    "Models",
  ]);

  const byCost = card({ overview: overview(), models: MODELS, days: 7, measure: "cost", now: NOW });
  expect(byCost.figures[0]).toEqual({ label: "Estimated cost", value: "$24.50" });
});

test("the sentence names the model that did the most, by the measure shown", () => {
  const byTokens = card({
    overview: overview(),
    models: MODELS,
    days: 7,
    measure: "tokens",
    now: NOW,
  });
  expect(byTokens.line).toBe("claude-opus-4-1 did 67% of the work.");

  const byCost = card({
    overview: overview(),
    models: MODELS,
    days: 30,
    measure: "cost",
    now: NOW,
  });
  expect(byCost.line).toBe("claude-opus-4-1 took 82% of the spend.");
});

test("one model is said plainly, and none says nothing", () => {
  const one = card({
    overview: overview(),
    models: [MODELS[0] as ModelUsage],
    days: 7,
    measure: "tokens",
    now: NOW,
  });
  expect(one.line).toBe("claude-opus-4-1, and nothing else.");

  const none = card({ overview: overview(), models: [], days: 7, measure: "tokens", now: NOW });
  expect(none.line).toBe("");
  expect(none.models).toEqual([]);
});

test("models rank by the measure, and unpriced ones rank below priced ones by cost", () => {
  const models = [
    model("cheap-and-busy", 9_000_000, 0.5, "codex"),
    model("unpriced", 5_000_000, null, "open_code"),
    model("dear-and-quiet", 1_000_000, 40, "claude_code"),
  ];
  const byCost = card({ overview: overview(), models, days: 7, measure: "cost", now: NOW });
  expect(byCost.models.map((each) => each.model)).toEqual([
    "dear-and-quiet",
    "cheap-and-busy",
    "unpriced",
  ]);
  expect(byCost.models.map((each) => each.value)).toEqual(["$40.00", "$0.50", "—"]);
  // Bars are measured against the largest, and an unknown amount has no bar.
  expect(byCost.models.map((each) => each.share)).toEqual([1, 0.0125, 0]);

  const byTokens = card({ overview: overview(), models, days: 7, measure: "tokens", now: NOW });
  expect(byTokens.models.map((each) => each.model)).toEqual([
    "cheap-and-busy",
    "unpriced",
    "dear-and-quiet",
  ]);
});

test("all of history runs from the first day recorded, and says so", () => {
  const all = card({
    overview: overview(),
    models: MODELS,
    days: null,
    measure: "tokens",
    now: NOW,
  });
  expect(all.period).toBe("All time");
  expect(all.range).toBe(`Sep 15${TO}16`);
  expect(all.name).toBe("overwatch-all-time-2026-09-16");

  const empty = card({
    overview: overview({ sessions: 0, daily: [], byAgent: [] }),
    models: [],
    days: null,
    measure: "tokens",
    now: NOW,
  });
  expect(empty.range).toBe("");
  expect(empty.agents).toEqual([]);
});

test("a card is named for the period it covers and the day it was made", () => {
  const seven = card({
    overview: overview(),
    models: MODELS,
    days: 7,
    measure: "tokens",
    now: NOW,
  });
  expect(seven.name).toBe("overwatch-7-days-2026-09-16");
  expect(seven.period).toBe("Last 7 days");
  expect(seven.range).toBe(`Sep 10${TO}16`);
});

test("agents rank beside the models, largest first, against the busiest", () => {
  const byTokens = card({
    overview: overview(),
    models: MODELS,
    days: 7,
    measure: "tokens",
    now: NOW,
  });
  expect(byTokens.agents).toEqual([
    { agent: "claude_code", value: 2_000_000, share: 1, label: "2.0M" },
    { agent: "codex", value: 1_000_000, share: 0.5, label: "1.0M" },
  ]);

  // Unpriced usage has no width by cost, and says so rather than reading as free.
  const unpriced = card({
    overview: overview({
      byAgent: [
        { agent: "claude_code", sessions: 8, tokens: tokens(2_000_000), costUsd: 20 },
        { agent: "grok_build", sessions: 4, tokens: tokens(1_000_000), costUsd: null },
      ],
    }),
    models: MODELS,
    days: 7,
    measure: "cost",
    now: NOW,
  });
  expect(unpriced.agents).toEqual([{ agent: "claude_code", value: 20, share: 1, label: "$20.00" }]);
});
