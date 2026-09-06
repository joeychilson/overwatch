import type { Model } from "./catalog";

// Presentation only: a shared name never establishes identity or pricing.
// Session headers lack provider metadata, so conflicting catalog labels fall
// back to the original identifier rather than choosing an arbitrary offering.
export function modelNameLookup(models: Model[]) {
  const names = new Map<string, Set<string>>();
  for (const model of models) {
    const labels = names.get(model.id) ?? new Set<string>();
    labels.add(model.name || model.id);
    names.set(model.id, labels);
  }
  return (id: string): string => {
    const labels = names.get(id);
    return labels?.size === 1 ? labels.values().next().value! : id || "Unknown model";
  };
}
