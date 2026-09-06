import type { ModelUsage } from "./analytics";
import { modelColor, providerColor } from "../models/colors";

export type UsageGroup = {
  key: string;
  label: string;
  detail: string;
  color: string;
  resolved: boolean;
  offerings: ModelUsage[];
  tokens: number;
  cost: number;
  calls: number;
  pricedCalls: number;
  unpricedCalls: number;
  recordedCost: number;
  estimatedCost: number;
  unpriced: number;
};

export function usageGroups(rows: ModelUsage[], grouping: "model" | "provider"): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const row of rows) {
    const identity = row.identity;
    const key = grouping === "model" ? identity.key : row.provider;
    const group = groups.get(key) ?? {
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
      cost: 0,
      calls: 0,
      pricedCalls: 0,
      unpricedCalls: 0,
      recordedCost: 0,
      estimatedCost: 0,
      unpriced: 0,
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
      "unpriced",
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
