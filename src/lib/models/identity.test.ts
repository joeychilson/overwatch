import { describe, expect, it } from "vite-plus/test";
import { parseCatalog } from "./catalog";
import { modelIdentityLookup } from "./identity";
import { aggregate, emptyTokens } from "../usage/analytics";
import { usageGroups } from "../usage/groups";
import { usageChart } from "../usage/chart";
import type { Session } from "../bindings";

const entry = (id: string) => ({ id, name: "Same display name", cost: { input: 1 } });
const catalog = parseCatalog({
  openai: {
    name: "OpenAI",
    models: {
      "gpt-example": entry("gpt-example"),
      "gpt-example-20260801": entry("gpt-example-20260801"),
    },
  },
  azure: {
    name: "Azure",
    models: { "gpt-example": { ...entry("gpt-example"), cost: { input: 3 } } },
  },
  openrouter: {
    name: "OpenRouter",
    models: {
      "openai/gpt-example": { ...entry("openai/gpt-example"), cost: { input: 5 } },
      "openai/gpt-example:free": entry("openai/gpt-example:free"),
    },
  },
  custom: { name: "Custom", models: { "gpt-example": entry("gpt-example") } },
});

describe("model identity", () => {
  it("combines supported exact routes without merging dates, variants, unknown providers or names", () => {
    const find = modelIdentityLookup(catalog);
    const direct = find("gpt-example", "openai");
    expect(direct.resolved).toBe(true);
    expect(find("gpt-example", "azure").key).toBe(direct.key);
    expect(find("openai/gpt-example", "openrouter").key).toBe(direct.key);
    for (const [id, provider] of [
      ["gpt-example-20260801", "openai"],
      ["openai/gpt-example:free", "openrouter"],
      ["gpt-example", "custom"],
      ["gpt-example", ""],
      ["gpt-example-latest", "azure"],
      ["openai/gpt-example", "unlisted"],
    ]) {
      expect(find(id, provider).key).not.toBe(direct.key);
    }
    expect(find("gpt-example", "custom").resolved).toBe(false);
    expect(find("gpt-example", "").resolved).toBe(false);
  });
  it("does not let catalog order resolve a host's ambiguous identifier", () => {
    const conflicting = { ...catalog[0], key: "anthropic/gpt-example", provider: "anthropic" };
    for (const models of [
      [...catalog, conflicting],
      [conflicting, ...catalog],
    ])
      expect(modelIdentityLookup(models)("gpt-example", "azure").resolved).toBe(false);
  });
  it("keeps identical display names distinguishable in charts and rankings", () => {
    const timestamp = new Date("2026-08-01T00:00:00").getTime();
    const sessions = [
      {
        agent: "codex",
        usage: ["gpt-example", "gpt-example-20260801"].map((model) => ({
          timestamp,
          provider: "openai",
          model,
          tokens: { ...emptyTokens(), input: 100 },
          reportedCost: null,
        })),
      },
    ] as Session[];
    const groups = usageGroups(aggregate(sessions, catalog).models, "model");
    expect(new Set(groups.map((group) => group.label)).size).toBe(2);
    expect(groups.some((group) => group.label.includes("20260801"))).toBe(true);
  });
  it("reconciles cross-agent/provider groups and keeps each offering's own rates", () => {
    const start = new Date("2026-08-01T00:00:00").getTime();
    const sessions = [
      ["openai", "gpt-example", "codex"],
      ["azure", "gpt-example", "pi"],
      ["openrouter", "openai/gpt-example", "opencode"],
    ].map(([provider, model, agent]) => ({
      id: provider,
      agent,
      usage: [
        {
          timestamp: start,
          provider,
          model,
          tokens: { ...emptyTokens(), input: 1_000_000 },
          reportedCost: null,
        },
      ],
    })) as Session[];
    const stats = aggregate(sessions, catalog, start, start + 86400000);
    expect(stats.models).toHaveLength(3);
    const [group] = usageGroups(stats.models, "model");
    expect(group.tokens).toBe(3_000_000);
    expect(group.cost).toBe(9);
    expect(group.estimatedCost).toBe(9);
    expect(group.offerings).toHaveLength(3);
    for (const grouping of ["agent", "model", "provider"] as const) {
      for (const metric of ["tokens", "cost"] as const) {
        const chart = usageChart(stats, start, start, grouping, metric, false);
        expect(chart.series).toHaveLength(grouping === "model" ? 1 : 3);
        expect(chart.series.reduce((sum, series) => sum + series.total, 0)).toBe(
          metric === "tokens" ? 3_000_000 : 9,
        );
        expect(chart.points[0].total).toBe(metric === "tokens" ? 3_000_000 : 9);
      }
    }
  });
});
