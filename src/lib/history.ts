import { useMemo } from "react";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import {
  commands,
  type HistoryScope,
  type SessionQuery,
  type UsageReport,
  type QueryTotals,
} from "./bindings";
import { AppFailure, native } from "./errors";
import { catalogOptions } from "./queries";
import { emptyModels, type Model } from "./models/catalog";
import { modelIdentityLookup } from "./models/identity";
import { aggregate, type DailyUsage } from "./usage/analytics";

export const historyOptions = queryOptions({
  queryKey: ["history"],
  queryFn: () => native(commands.getHistoryStatus()),
  enabled: isTauri(),
  staleTime: Infinity,
});
export const logAllowanceOptions = queryOptions({
  queryKey: ["log-allowances"],
  queryFn: () => native(commands.getLogAllowances()),
  enabled: isTauri(),
  staleTime: Infinity,
});
export function historyScope(scope: Partial<HistoryScope> = {}): HistoryScope {
  return { agent: null, project: null, start: null, end: null, offerings: [], ...scope };
}
export function sessionQuery(
  scope: Partial<HistoryScope> = {},
  query: Partial<SessionQuery> = {},
): SessionQuery {
  return {
    scope: historyScope(scope),
    search: "",
    searchModels: [],
    activityAfter: null,
    activityBefore: null,
    day: null,
    tool: null,
    model: null,
    failedOnly: false,
    usageOnly: false,
    offset: 0,
    limit: 50,
    sort: "updatedAt",
    descending: true,
    ...query,
  };
}
export function sessionOptions(query: SessionQuery) {
  return queryOptions({
    queryKey: ["sessions", query],
    queryFn: () => native(commands.getSessions(query)),
    enabled: isTauri(),
    staleTime: Infinity,
  });
}
export function navigationOptions(id: string, query: SessionQuery) {
  return queryOptions({
    queryKey: ["session-navigation", id, query],
    queryFn: () => native(commands.getSessionNavigation(query, id)),
    enabled: isTauri() && !!id,
    staleTime: Infinity,
  });
}
export function toolOptions(scope: HistoryScope) {
  return queryOptions({
    queryKey: ["tools", scope],
    queryFn: () => native(commands.getToolStats(scope)),
    enabled: isTauri(),
    staleTime: Infinity,
  });
}

export type UsageStats = Omit<ReturnType<typeof aggregate>, "sessionIds"> & {
  sessionCount: number;
  projectCount: number;
  agentCount: number;
  longestSession: number | null;
};
export function reportStats(report: UsageReport, models: Model[]): UsageStats {
  const identity = modelIdentityLookup(models);
  const names = new Map(models.map((model) => [model.provider, model.providerName]));
  return {
    ...totals(report.totals),
    sessionCount: report.sessionCount,
    projectCount: report.projectCount,
    agentCount: report.agentCount,
    longestSession: report.longestSession,
    days: new Map(
      report.days.map((point): [string, DailyUsage] => [
        point.day,
        {
          ...totals(point.totals),
          day: point.day,
          agents: point.agents,
          agentCosts: Object.fromEntries(
            Object.entries(point.agentCosts).map(([agent, cost]) => [agent, finiteCost(cost)]),
          ),
          agentPricedCalls: point.agentPricedCalls,
          models: Object.fromEntries(
            Object.entries(point.models).map(([key, model]) => [
              key,
              { ...model, cost: finiteCost(model.cost) },
            ]),
          ),
        },
      ]),
    ),
    models: report.models.map((row) => ({
      ...totals(row.totals),
      tokens: row.totals.total,
      key: `${row.provider}/${row.model}`,
      model: row.model,
      provider: row.provider,
      providerName: names.get(row.provider) || row.provider || "Unknown provider",
      identity: identity(row.model, row.provider),
    })),
  };
}
function finiteCost(value: number | null): number {
  if (value == null || !Number.isFinite(value))
    throw new AppFailure({
      kind: "invalidData",
      message: "The usage query returned an invalid cost total.",
    });
  return value;
}
function totals(value: QueryTotals) {
  return {
    ...value,
    cost: finiteCost(value.cost),
    recordedCost: finiteCost(value.recordedCost),
    estimatedCost: finiteCost(value.estimatedCost),
  };
}
export function useUsage(scope: HistoryScope) {
  const catalog = useQuery(catalogOptions);
  const models = catalog.data?.models ?? emptyModels;
  const query = useSuspenseQuery({
    queryKey: ["usage", scope, catalog.data?.updatedAt],
    queryFn: () => native(commands.getUsage(scope)),
    staleTime: Infinity,
  });
  const stats = useMemo(() => reportStats(query.data, models), [query.data, models]);
  return { ...query, stats };
}
