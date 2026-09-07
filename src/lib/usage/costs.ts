import type { Tokens } from "../bindings";
import type { Model } from "../models/catalog";

export type CostTotals = {
  cost: number;
  pricedCalls: number;
  unpricedCalls: number;
  recordedCost: number;
  estimatedCost: number;
};

export const emptyCosts = (): CostTotals => ({
  cost: 0,
  pricedCalls: 0,
  unpricedCalls: 0,
  recordedCost: 0,
  estimatedCost: 0,
});

export function addCost(totals: CostTotals, cost: number | null, recorded: boolean): void {
  if (cost == null) {
    totals.unpricedCalls++;
    return;
  }
  totals.cost += cost;
  totals.pricedCalls++;
  if (recorded) totals.recordedCost += cost;
  else totals.estimatedCost += cost;
}

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

/** A subtotal exists only when at least one response has a known cost. */
export function knownCost(value: Pick<CostTotals, "cost" | "pricedCalls">): number | null {
  return value.pricedCalls > 0 ? value.cost : null;
}
