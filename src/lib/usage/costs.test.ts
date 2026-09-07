import { describe, expect, it } from "vite-plus/test";
import { parseCatalog } from "../models/catalog";
import { emptyTokens, totalTokens } from "./analytics";
import { priceLookup, tokenCost } from "./costs";

const models = parseCatalog({
  lab: {
    name: "Lab",
    models: {
      test: {
        id: "test",
        name: "Test",
        cost: { input: 2, output: 8, cache_read: 0.2 },
        limit: { context: 100000 },
      },
    },
  },
});

describe("model pricing", () => {
  it("does not add reasoning twice and refuses missing cache prices", () => {
    const tokens = { ...emptyTokens(), input: 1_000_000, output: 100_000, reasoning: 50_000 };
    expect(totalTokens(tokens)).toBe(1_100_000);
    expect(tokenCost(tokens, models[0])).toBeCloseTo(2.8);
    expect(tokenCost({ ...tokens, cacheWrite: 1 }, models[0])).toBeNull();
  });
  it("never prices a known reseller using another provider's rates", () => {
    expect(priceLookup(models)("test", "different-provider")).toBeUndefined();
    expect(priceLookup(models)("test", "")).toBe(models[0]);
  });
  it("leaves ambiguous providers and unmatched versions unpriced regardless of catalog order", () => {
    const reseller = { ...models[0], provider: "reseller", key: "reseller/test", inputPrice: 12 };
    for (const catalog of [
      [models[0], reseller],
      [reseller, models[0]],
    ]) {
      const find = priceLookup(catalog);
      expect(find("test", "")).toBeUndefined();
      expect(find("test", "reseller")).toBe(reseller);
      expect(find("test-20260820", "lab")).toBeUndefined();
      expect(find("test-latest", "lab")).toBeUndefined();
    }
  });
});
