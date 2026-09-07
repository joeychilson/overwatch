import { describe, expect, it } from "vite-plus/test";
import { addDays } from "date-fns";
import type { Session } from "../bindings";
import { aggregate, emptyTokens } from "./analytics";
import { usageChart } from "./chart";
import { modelColor, providerColor } from "../models/colors";

const start = new Date("2026-08-03T00:00:00").getTime();
const end = addDays(start, 10).getTime();
const sessions: Session[] = Array.from({ length: 7 }, (_, index) => ({
  id: String(index),
  agent: index % 2 ? "claude" : "codex",
  title: "Session",
  cwd: "/fixture",
  project: "fixture",
  model: `model.${index}`,
  startedAt: start,
  updatedAt: end,
  messages: 1,
  turns: 1,
  compactions: 0,
  tokens: emptyTokens(),
  usage: [
    {
      timestamp: addDays(start, index).getTime(),
      provider: index % 2 ? "anthropic" : "openai",
      model: `model.${index}`,
      tokens: { ...emptyTokens(), input: (index + 1) * 100, output: 10, reasoning: 5 },
      reportedCost: index === 6 ? null : index,
    },
  ],
  tools: [],
  limits: [],
  sourcePath: "/fixture",
  parentId: null,
  warnings: [],
}));

describe("usage chart", () => {
  it("keeps token and priced-cost totals exact across both groupings and bucket sizes", () => {
    const stats = aggregate(sessions, [], start, end);
    expect(stats.total).toBe(2870);
    expect(stats.cost).toBe(15);
    expect(stats.unpriced).toBe(710);
    for (const grouping of ["agent", "model", "provider"] as const) {
      for (const metric of ["tokens", "cost"] as const) {
        for (const weekly of [false, true]) {
          const chart = usageChart(stats, start, end - 1, grouping, metric, weekly);
          expect(chart.series.reduce((sum, series) => sum + series.total, 0)).toBe(
            metric === "tokens" ? stats.total : stats.cost,
          );
          expect(chart.points.reduce((sum, point) => sum + point.total, 0)).toBe(
            metric === "tokens" ? stats.total : stats.cost,
          );
          for (const field of [
            "recordedCost",
            "estimatedCost",
            "unpricedCalls",
            "pricedCalls",
          ] as const) {
            expect(chart.points.reduce((sum, point) => sum + point[field], 0)).toBe(stats[field]);
          }
          for (const point of chart.points) {
            expect(
              chart.series.reduce(
                (sum, series) => sum + Number(Reflect.get(point, series.dataKey)),
                0,
              ),
            ).toBe(point.total);
          }
          if (grouping === "model") {
            expect(chart.series).toHaveLength(6);
            expect(chart.series.at(-1)?.label).toBe("Other models");
            expect(chart.series.every((series) => /^series\d+$/.test(series.dataKey))).toBe(true);
          }
          expect(chart.points).toHaveLength(weekly ? 2 : 10);
        }
      }
    }
  });
  it("retains every provider's costs and tokens in the top-five remainder", () => {
    const many = sessions.map((session, index) => ({
      ...session,
      usage: session.usage.map((usage) => ({ ...usage, provider: `provider-${index}` })),
    }));
    const stats = aggregate(many, [], start, end);
    for (const metric of ["tokens", "cost"] as const) {
      const chart = usageChart(stats, start, end - 1, "provider", metric, true);
      expect(chart.series).toHaveLength(6);
      expect(chart.series.at(-1)?.label).toBe("Other providers");
      expect(chart.series.reduce((sum, item) => sum + item.total, 0)).toBe(
        metric === "tokens" ? stats.total : stats.cost,
      );
      for (const point of chart.points)
        expect(
          chart.series.reduce((sum, item) => sum + Number(Reflect.get(point, item.dataKey)), 0),
        ).toBe(point.total);
    }
  });
  it("excludes out-of-period usage and preserves empty days", () => {
    const stats = aggregate(sessions, [], start, addDays(start, 1).getTime());
    const chart = usageChart(stats, start, end - 1, "agent", "tokens", false);
    expect(chart.points[0].total).toBe(110);
    expect(chart.points.slice(1).every((point) => point.total === 0)).toBe(true);
  });
  it("keeps provider and model colors stable independent of rankings", () => {
    expect(providerColor("openai")).not.toBe(providerColor("anthropic"));
    expect(providerColor("new-provider")).toBe(providerColor("NEW-PROVIDER"));
    const stats = aggregate(sessions, [], start, end);
    const token = usageChart(stats, start, end, "model", "tokens", false);
    const cost = usageChart(stats, start, end, "model", "cost", false);
    for (const series of token.series.filter((series) => series.key !== "__other")) {
      const other = cost.series.find((item) => item.key === series.key);
      if (other) expect(other.color).toBe(series.color);
    }
    expect(modelColor("openai", "model.1")).toBe(modelColor("openai", "model.1"));
  });
});
