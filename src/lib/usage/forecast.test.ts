import { describe, expect, it } from "vite-plus/test";
import { subscriptionWarnings, type Forecast } from "./forecast";

function reading(
  agent: Forecast["latest"]["agent"],
  usedPercent: number,
  overrides: Partial<Forecast> = {},
): Forecast {
  return {
    latest: {
      agent,
      usedPercent,
      bucket: "weekly",
      label: "Weekly",
      accountKey: "account",
      windowMinutes: 10080,
      resetsAt: 10000,
      timestamp: 1000,
      source: "test",
    },
    samples: [],
    state: "collecting",
    percentPerHour: null,
    exhaustionAt: null,
    atReset: null,
    ...overrides,
  };
}

describe("subscription warnings", () => {
  it("selects the earliest limit per provider and ignores resets before exhaustion", () => {
    const short = reading("codex", 90, { state: "projected", exhaustionAt: 11000 });
    const weekly = reading("codex", 50, { state: "projected", exhaustionAt: 5000 });
    const claude = reading("claude", 40, { state: "projected", exhaustionAt: 3000 });
    const input = [short, weekly, reading("grok", 99), claude];
    expect(subscriptionWarnings(input, 1000)).toEqual([claude, weekly]);
    expect(input[0]).toBe(short);
  });

  it("includes the 24-hour boundary but excludes later projections and equal reset times", () => {
    const now = 1000;
    const boundary = reading("codex", 20, { state: "projected", exhaustionAt: now + 86_400_000 });
    boundary.latest.resetsAt = now + 7 * 86_400_000;
    const later = { ...boundary, exhaustionAt: boundary.exhaustionAt! + 1 };
    expect(subscriptionWarnings([boundary], now)).toEqual([boundary]);
    expect(subscriptionWarnings([later], now)).toEqual([]);
    expect(
      subscriptionWarnings([{ ...boundary, exhaustionAt: boundary.latest.resetsAt }], now),
    ).toEqual([]);
  });

  it("shows each provider once without dropping other providers at risk", () => {
    const weekly = reading("codex", 70, { state: "projected", exhaustionAt: 5000 });
    const short = reading("codex", 90, { state: "projected", exhaustionAt: 2000 });
    short.latest.bucket = "short";
    const claude = reading("claude", 80, { state: "projected", exhaustionAt: 3000 });
    const grok = reading("grok", 100);
    expect(subscriptionWarnings([weekly, claude, short, grok], 1000)).toEqual([
      grok,
      short,
      claude,
    ]);
  });

  it("ranks reached limits first, includes overdue estimates, and excludes unconfirmed risks", () => {
    const reached = reading("grok", 100);
    const overdue = reading("claude", 80, { state: "projected", exhaustionAt: 500 });
    expect(subscriptionWarnings([overdue, reached], 1000)).toEqual([reached, overdue]);
    for (const state of ["stale", "expired", "steady", "collecting"] as const) {
      expect(subscriptionWarnings([reading("codex", 99, { state })], 1000)).toEqual([]);
    }
    for (const state of ["stale", "expired"] as const) {
      expect(subscriptionWarnings([reading("codex", 100, { state })], 1000)).toEqual([]);
    }
    expect(subscriptionWarnings([], 1000)).toEqual([]);
  });
});
