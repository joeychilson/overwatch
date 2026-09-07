import type { ModelUsage } from "./analytics";
import { emptyCosts, type CostTotals } from "./costs";
import { modelColor, providerColor } from "../models/colors";

export type UsageGroup = CostTotals & {
  key: string;
  label: string;
  detail: string;
  color: string;
  resolved: boolean;
  offerings: ModelUsage[];
  tokens: number;
  calls: number;
};

export function usageGroups(rows: ModelUsage[], grouping: "model" | "provider"): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const row of rows) {
    const identity = row.identity;
    const key = grouping === "model" ? identity.key : row.provider;
    const group = groups.get(key) ?? {
      ...emptyCosts(),
      key,
      label: grouping === "model" ? identity.name : row.providerName,
      detail: grouping === "model" ? identity.id : row.provider,
      color:
        grouping === "model"
          ? modelColor(identity.owner, identity.id)
          : providerColor(row.provider),
      resolved: grouping === "provider" || identity.resolved,
      offerings: [],
      tokens: 0,
      calls: 0,
    };
    group.offerings.push(row);
    for (const field of [
      "tokens",
      "cost",
      "calls",
      "pricedCalls",
      "unpricedCalls",
      "recordedCost",
      "estimatedCost",
    ] as const)
      group[field] += row[field];
    groups.set(key, group);
  }
  const labels = new Map<string, number>();
  for (const group of groups.values()) labels.set(group.label, (labels.get(group.label) ?? 0) + 1);
  if (grouping === "model")
    for (const group of groups.values()) {
      if ((labels.get(group.label) ?? 0) > 1) group.label = `${group.label} (${group.detail})`;
    }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
}

export function offeringProviderNames(group: Pick<UsageGroup, "offerings">): string[] {
  return [...new Set(group.offerings.map((offering) => offering.providerName))];
}
