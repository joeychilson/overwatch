import type { Model } from "./catalog";

// Explicit catalog namespaces and routing formats. Never strip versions, dates,
// deployment suffixes, or variants, and never infer identity from display names.
const creators = new Set(["openai", "anthropic", "google", "xai", "deepseek", "mistral"]);
const routers = new Set(["openrouter", "vercel"]);
const exactIdHosts = new Set(["azure", "azure-cognitive-services", "github-copilot", "opencode"]);

export type ModelIdentity = {
  key: string;
  id: string;
  name: string;
  owner: string;
  resolved: boolean;
};

export function modelIdentityLookup(models: Model[]) {
  const catalog = new Map(models.map((model) => [model.key, model]));
  const owners = new Map<string, Model[]>();
  for (const model of models) {
    if (!creators.has(model.provider)) continue;
    const candidates = owners.get(model.id) ?? [];
    candidates.push(model);
    owners.set(model.id, candidates);
  }
  const cache = new Map<string, ModelIdentity>();
  return (id: string, provider: string): ModelIdentity => {
    const key = JSON.stringify([provider, id]);
    const cached = cache.get(key);
    if (cached) return cached;
    const offering = catalog.get(`${provider}/${id}`);
    let owner = creators.has(provider) ? provider : undefined;
    let canonicalId = id;
    // A routed identifier must be present in both catalogs. The route prefix is
    // an explicit creator namespace, not an arbitrary slash to discard.
    if (offering && routers.has(provider)) {
      const slash = id.indexOf("/");
      const namespace = id.slice(0, slash);
      const candidate = id.slice(slash + 1);
      if (slash > 0 && creators.has(namespace) && catalog.has(`${namespace}/${candidate}`)) {
        owner = namespace;
        canonicalId = candidate;
      }
    }
    if (offering && exactIdHosts.has(provider)) {
      const candidates = owners.get(id);
      if (candidates?.length === 1) owner = candidates[0].provider;
    }
    const canonical = owner ? catalog.get(`${owner}/${canonicalId}`) : undefined;
    const identity: ModelIdentity = {
      key: JSON.stringify(owner ? ["model", owner, canonicalId] : ["offering", provider, id]),
      id: canonicalId,
      name: canonical?.name || offering?.name || id || "Unknown model",
      owner: owner ?? provider,
      resolved: !!owner,
    };
    cache.set(key, identity);
    return identity;
  };
}
