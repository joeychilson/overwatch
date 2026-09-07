import { addDays, differenceInCalendarDays, startOfDay, subDays } from "date-fns";
import { agentIds } from "../agents";
import type { Agent, Session, Tokens, ToolUsage } from "../bindings";
import type { Model } from "../models/catalog";
import { modelIdentityLookup, type ModelIdentity } from "../models/identity";
import { day, hasTimestamp } from "../format";
import { addCost, emptyCosts, priceLookup, tokenCost, type CostTotals } from "./costs";

export const totalTokens = (tokens: Tokens) =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;

export const emptyTokens = (): Tokens => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
});

export type DailyUsage = CostTotals & {
  day: string;
  total: number;
  unpriced: number;
  agents: Partial<Record<Agent, number>>;
  agentCosts: Partial<Record<Agent, number>>;
  agentPricedCalls: Partial<Record<Agent, number>>;
  models: Record<string, { tokens: number; cost: number }>;
};

export type ModelUsage = CostTotals & {
  key: string;
  model: string;
  provider: string;
  providerName: string;
  identity: ModelIdentity;
  tokens: number;
  calls: number;
};

export function aggregate(sessions: Session[], models: Model[], start = 0, end = Infinity) {
  const find = priceLookup(models);
  const identity = modelIdentityLookup(models);
  const providerNames = new Map(models.map((model) => [model.provider, model.providerName]));
  const tokens = emptyTokens();
  const costs = emptyCosts();
  const sessionIds = new Set<string>();
  const days = new Map<string, DailyUsage>();
  const ranking = new Map<string, ModelUsage>();
  // Agent logs usually contain many consecutive responses on the same local day.
  // Calendar boundaries (rather than a fixed 24h duration) preserve DST grouping.
  let bucketStart = Infinity;
  let bucketEnd = -Infinity;
  let bucketDay = "";
  let unpriced = 0;
  let calls = 0;
  let undatedCalls = 0;
  let undatedTokens = 0;
  for (const session of sessions)
    for (const usage of session.usage) {
      // Native parsers use zero when the source timestamp is absent/invalid.
      const dated = hasTimestamp(usage.timestamp);
      if (!dated) {
        undatedCalls++;
        undatedTokens += totalTokens(usage.tokens);
        // Retain unknown-date responses in lifetime totals, never assign a day.
        if (start > 0 || end !== Infinity) continue;
      } else if (usage.timestamp < start || usage.timestamp >= end) continue;
      sessionIds.add(session.id);
      for (const field of ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const)
        tokens[field] += usage.tokens[field];
      const count = totalTokens(usage.tokens);
      const price =
        usage.reportedCost ?? tokenCost(usage.tokens, find(usage.model, usage.provider));
      const recorded = usage.reportedCost != null;
      const key = `${usage.provider}/${usage.model}`;
      const row = ranking.get(key) ?? {
        ...emptyCosts(),
        key,
        model: usage.model,
        provider: usage.provider,
        providerName: providerNames.get(usage.provider) || usage.provider || "Unknown provider",
        identity: identity(usage.model, usage.provider),
        tokens: 0,
        calls: 0,
      };
      row.tokens += count;
      row.calls++;
      addCost(row, price, recorded);
      ranking.set(key, row);
      if (dated) {
        if (!(usage.timestamp >= bucketStart && usage.timestamp < bucketEnd)) {
          const boundary = startOfDay(usage.timestamp);
          bucketStart = boundary.getTime();
          bucketEnd = addDays(boundary, 1).getTime();
          bucketDay = day(boundary);
        }
        const date = bucketDay;
        const point = days.get(date) ?? {
          ...emptyCosts(),
          day: date,
          total: 0,
          unpriced: 0,
          agents: {},
          agentCosts: {},
          agentPricedCalls: {},
          models: {},
        };
        addCost(point, price, recorded);
        point.total += count;
        point.unpriced += price == null ? count : 0;
        point.agents[session.agent] = (point.agents[session.agent] ?? 0) + count;
        point.agentPricedCalls[session.agent] =
          (point.agentPricedCalls[session.agent] ?? 0) + (price == null ? 0 : 1);
        point.agentCosts[session.agent] = (point.agentCosts[session.agent] ?? 0) + (price ?? 0);
        const modelPoint = point.models[key] ?? { tokens: 0, cost: 0 };
        modelPoint.tokens += count;
        modelPoint.cost += price ?? 0;
        point.models[key] = modelPoint;
        days.set(date, point);
      }
      addCost(costs, price, recorded);
      unpriced += price == null ? count : 0;
      calls++;
    }
  return {
    ...costs,
    tokens,
    total: totalTokens(tokens),
    unpriced,
    calls,
    days,
    undatedCalls,
    undatedTokens,
    sessionIds: [...sessionIds],
    models: [...ranking.values()].sort((a, b) => b.tokens - a.tokens),
  };
}

export function toolStats(sessions: Session[]): ToolUsage[] {
  const totals = new Map<string, ToolUsage>();
  for (const session of sessions)
    for (const tool of session.tools) {
      const row = totals.get(tool.name) ?? {
        name: tool.name,
        calls: 0,
        failures: 0,
        completed: 0,
        timed: 0,
        durationMs: 0,
        agents: [],
      };
      if (!row.agents.includes(session.agent)) row.agents.push(session.agent);
      row.calls += tool.calls;
      row.failures += tool.failures;
      row.completed += tool.completed;
      row.timed += tool.timed;
      row.durationMs += tool.durationMs;
      totals.set(tool.name, row);
    }
  return [...totals.values()]
    .map((row) => ({ ...row, agents: agentIds.filter((agent) => row.agents.includes(agent)) }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

export function activity(days: Map<string, DailyUsage>, now = new Date()) {
  const active = [...days.values()]
    .filter((point) => point.total > 0)
    .sort((a, b) => a.day.localeCompare(b.day));
  const dates = new Set(active.map((point) => point.day));
  let longest = 0,
    run = 0,
    current = 0;
  active.forEach((point, index) => {
    run =
      index &&
      differenceInCalendarDays(
        new Date(`${point.day}T12:00:00`),
        new Date(`${active[index - 1].day}T12:00:00`),
      ) === 1
        ? run + 1
        : 1;
    longest = Math.max(longest, run);
  });
  let cursor = startOfDay(dates.has(day(now)) ? now : subDays(now, 1));
  while (dates.has(day(cursor))) {
    current++;
    cursor = subDays(cursor, 1);
  }
  const peak = active.reduce<DailyUsage | undefined>(
    (peak, point) => (!peak || point.total > peak.total ? point : peak),
    undefined,
  );
  return { current, longest, activeDays: active.length, peak };
}
