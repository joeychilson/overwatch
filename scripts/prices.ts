/**
 * Refresh the model prices the engine estimates cost with.
 *
 * Downloads the models.dev catalog, which OpenCode and Pi price with too, and
 * keeps only what pricing needs: every provider's models and their dollars per
 * million tokens. Each model gets its base rates first, then the rates above
 * each context size it charges more for, with any rate the catalog leaves out
 * filled in the way providers bill it: cache reads and writes at the input
 * rate, and reasoning at the output rate.
 *
 * Writes one model per line, so a price change reads as a one-line diff.
 * Run with `vp run prices` and commit the result.
 */
import { writeFileSync } from "node:fs";

type Rates = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
};
type Catalog = Record<
  string,
  {
    models?: Record<
      string,
      { cost?: Rates & { tiers?: (Rates & { tier?: { type?: string; size?: number } })[] } }
    >;
  }
>;

const catalog = (await (await fetch("https://models.dev/api.json")).json()) as Catalog;

/**
 * Every rate, taking what `rates` leaves out from the rates it refines and
 * then from its own input and output rates.
 */
function filled(rates: Rates, refined: Rates = {}) {
  const input = rates.input ?? refined.input ?? 0;
  const output = rates.output ?? refined.output ?? 0;
  return {
    input,
    output,
    cache_read: rates.cache_read ?? refined.cache_read ?? input,
    cache_write: rates.cache_write ?? refined.cache_write ?? input,
    reasoning: rates.reasoning ?? refined.reasoning ?? output,
  };
}

const lines = Object.keys(catalog)
  .sort()
  .flatMap((provider) => {
    const models = catalog[provider]?.models ?? {};
    const priced = Object.keys(models)
      .sort()
      .flatMap((model) => {
        const cost = models[model]?.cost;
        if (!cost) return [];
        const base = filled(cost);
        const tiers = (cost.tiers ?? [])
          .filter((tier) => tier.tier?.type === "context" && tier.tier.size)
          .sort((a, b) => (a.tier?.size ?? 0) - (b.tier?.size ?? 0))
          .map((tier) => ({ above: tier.tier?.size, ...filled(tier, cost) }));
        return [`${JSON.stringify(model)}:${JSON.stringify([base, ...tiers])}`];
      });
    return priced.length ? [`${JSON.stringify(provider)}:{\n${priced.join(",\n")}\n}`] : [];
  });

writeFileSync("src-tauri/src/prices.json", `{\n${lines.join(",\n")}\n}\n`);
console.log(`Priced ${lines.length} providers.`);
