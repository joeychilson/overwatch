import { addDays, differenceInCalendarDays, startOfDay, subDays } from "date-fns";
import type { Agent, Session, Tokens, ToolStats, Usage } from "../bindings";
import type { Model } from "../models/catalog";
import { modelIdentityLookup, type ModelIdentity } from "../models/identity";
import { day, hasTimestamp } from "../format";

export const totalTokens = (tokens: Tokens) =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;

export const emptyTokens = (): Tokens => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
});

export function priceLookup(models: Model[]) {
  const exact = new Map(models.map((model) => [model.key, model]));
  const byId = new Map<string, Model[]>();
  for (const model of models) {
    const candidates = byId.get(model.id) ?? [];
    candidates.push(model);
    byId.set(model.id, candidates);
  }
  return (model: string, provider: string): Model | undefined => {
    // Rates belong to an exact offering, not a similarly named version or reseller.
    if (provider) return exact.get(`${provider}/${model}`);
    const candidates = byId.get(model);
    return candidates?.length === 1 ? candidates[0] : undefined;
  };
}

export function tokenCost(tokens: Tokens, model: Model | undefined): number | null {
  if (!model) return null;
  const pairs = [
    [tokens.input, model.inputPrice],
    [tokens.cacheRead, model.cacheReadPrice],
    [tokens.cacheWrite, model.cacheWritePrice],
    [tokens.output, model.outputPrice],
  ] as const;
  let cost = 0;
  for (const [count, price] of pairs) {
    if (count > 0 && price == null) return null;
    cost += (count * (price ?? 0)) / 1_000_000;
  }
  return cost;
}

export const usageCost = (usage: Usage, find: ReturnType<typeof priceLookup>) =>
  usage.reportedCost ?? tokenCost(usage.tokens, find(usage.model, usage.provider));

export type DailyUsage = {
  day: string;
  total: number;
  cost: number;
  unpriced: number;
  unpricedCalls: number;
  recordedCost: number;
  estimatedCost: number;
  pricedCalls: number;
  agents: Partial<Record<Agent, number>>;
  agentCosts: Partial<Record<Agent, number>>;
  agentPricedCalls: Partial<Record<Agent, number>>;
  models: Record<string, { tokens: number; cost: number }>;
};

export type ModelUsage = {
  key: string;
  model: string;
  provider: string;
  providerName: string;
  identity: ModelIdentity;
  tokens: number;
  cost: number;
  unpriced: number;
  unpricedCalls: number;
  recordedCost: number;
  estimatedCost: number;
  pricedCalls: number;
  calls: number;
};

export function aggregate(sessions: Session[], models: Model[], start = 0, end = Infinity) {
  const find = priceLookup(models);
  const identity = modelIdentityLookup(models);
  const providerNames = new Map(models.map((model) => [model.provider, model.providerName]));
  const tokens = emptyTokens();
  const sessionIds = new Set<string>();
  const days = new Map<string, DailyUsage>();
  const ranking = new Map<string, ModelUsage>();
  // Agent logs usually contain many consecutive responses on the same local day.
  // Calendar boundaries (rather than a fixed 24h duration) preserve DST grouping.
  let bucketStart = Infinity;
  let bucketEnd = -Infinity;
  let bucketDay = "";
  let cost = 0;
  let unpriced = 0;
  let calls = 0;
  let unpricedCalls = 0;
  let pricedCalls = 0;
  let recordedCost = 0;
  let estimatedCost = 0;
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
      const price = usageCost(usage, find);
      const key = `${usage.provider}/${usage.model}`;
      const row = ranking.get(key) ?? {
        key,
        model: usage.model,
        provider: usage.provider,
        providerName: providerNames.get(usage.provider) || usage.provider || "Unknown provider",
        identity: identity(usage.model, usage.provider),
        tokens: 0,
        cost: 0,
        unpriced: 0,
        unpricedCalls: 0,
        pricedCalls: 0,
        recordedCost: 0,
        estimatedCost: 0,
        calls: 0,
      };
      row.tokens += count;
      row.cost += price ?? 0;
      row.unpriced += price == null ? count : 0;
      row.calls++;
      const recorded = usage.reportedCost != null ? (price ?? 0) : 0;
      const estimated = usage.reportedCost == null ? (price ?? 0) : 0;
      row.unpricedCalls += price == null ? 1 : 0;
      row.pricedCalls += price == null ? 0 : 1;
      row.recordedCost += recorded;
      row.estimatedCost += estimated;
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
          day: date,
          total: 0,
          cost: 0,
          unpriced: 0,
          unpricedCalls: 0,
          pricedCalls: 0,
          recordedCost: 0,
          estimatedCost: 0,
          agents: {},
          agentCosts: {},
          agentPricedCalls: {},
          models: {},
        };
        point.unpricedCalls += price == null ? 1 : 0;
        point.pricedCalls += price == null ? 0 : 1;
        point.recordedCost += recorded;
        point.estimatedCost += estimated;
        point.total += count;
        point.cost += price ?? 0;
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
      cost += price ?? 0;
      unpriced += price == null ? count : 0;
      calls++;
      unpricedCalls += price == null ? 1 : 0;
      pricedCalls += price == null ? 0 : 1;
      recordedCost += recorded;
      estimatedCost += estimated;
    }
  return {
    tokens,
    total: totalTokens(tokens),
    cost,
    unpriced,
    calls,
    pricedCalls,
    unpricedCalls,
    recordedCost,
    estimatedCost,
    days,
    undatedCalls,
    undatedTokens,
    sessionIds: [...sessionIds],
    models: [...ranking.values()].sort((a, b) => b.tokens - a.tokens),
  };
}

export function toolStats(sessions: Session[]): ToolStats[] {
  const totals = new Map<string, ToolStats>();
  for (const session of sessions)
    for (const tool of session.tools) {
      const row = totals.get(tool.name) ?? {
        name: tool.name,
        calls: 0,
        failures: 0,
        completed: 0,
        timed: 0,
        durationMs: 0,
      };
      row.calls += tool.calls;
      row.failures += tool.failures;
      row.completed += tool.completed;
      row.timed += tool.timed;
      row.durationMs += tool.durationMs;
      totals.set(tool.name, row);
    }
  return [...totals.values()].sort((a, b) => b.calls - a.calls);
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

/** A subtotal exists only when at least one response has a known cost. */
export function knownCost(value: { cost: number; pricedCalls: number }): number | null {
  return value.pricedCalls > 0 ? value.cost : null;
}
