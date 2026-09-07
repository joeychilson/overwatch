import { describe, expect, it } from "vite-plus/test";
import type { AccountStatus, QuotaSample, Session } from "../bindings";
import { forecasts, subscriptionForecasts, subscriptionWarnings, type Forecast } from "./forecast";

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

describe("quota forecasts", () => {
  const now = 1_800_000_000_000;
  const sample = (timestamp: number, usedPercent: number, accountKey = "a"): QuotaSample => ({
    agent: "codex",
    accountKey,
    bucket: "five-hour",
    label: "5 hour",
    usedPercent,
    windowMinutes: 300,
    resetsAt: now + 3600000,
    timestamp,
    source: "Account",
  });
  it("uses local readings until an account supplies its own history and current windows", () => {
    const local = { ...sample(now, 95), accountKey: null, source: "Session log" };
    const sessions = [{ limits: [local] }] as Session[];
    expect(subscriptionForecasts(undefined, sessions, now)[0].latest).toEqual(local);
    const latest = sample(now, 30);
    const account: AccountStatus = {
      agent: "codex",
      usage: {
        accountKey: "a",
        plan: null,
        source: "Account",
        updatedAt: now,
        windows: [latest],
        balances: [],
      },
      error: null,
      lastAttempt: now,
      nextRefreshAt: now + 300000,
    };
    const history = [sample(now - 1800000, 10), sample(now - 900000, 20)];
    const [result] = subscriptionForecasts(
      { accounts: [account], samples: history },
      sessions,
      now,
    );
    expect(result.latest).toEqual(latest);
    expect(result.samples).toEqual([...history, latest]);
    expect(result.state).toBe("projected");
    expect(subscriptionForecasts(undefined, [], now)).toEqual([]);
  });
  it("uses regression only with sufficient fresh observations", () => {
    const points = [sample(now - 1800000, 10), sample(now - 900000, 20), sample(now, 30)];
    const [forecast] = forecasts(points, [], now);
    expect(forecast.state).toBe("projected");
    expect(forecast.atReset).toBeCloseTo(70);
    expect(forecasts(points.slice(1), [], now)[0].state).toBe("collecting");
    expect(forecasts(points, [], now + 900001)[0].state).toBe("stale");
  });
  it("does not mix reset windows, quota decreases, or identities", () => {
    const points = [sample(now - 1800000, 50), sample(now - 900000, 60), sample(now, 10)];
    expect(forecasts(points, [], now)[0].state).toBe("collecting");
    const current = sample(now, 20, "b");
    const account: AccountStatus = {
      agent: "codex",
      usage: {
        accountKey: "b",
        plan: null,
        source: "Account",
        updatedAt: now,
        windows: [current],
        balances: [],
      },
      error: null,
      lastAttempt: now,
      nextRefreshAt: now + 300000,
    };
    expect(forecasts([...points, current], [account], now)[0].samples).toEqual([current]);
  });
  it("marks a finished window as expired even when the last reading is stale", () => {
    const reading = { ...sample(now - 1_800_000, 42), resetsAt: now - 60_000 };
    expect(forecasts([reading], [], now)[0].state).toBe("expired");
  });
  it("orders allowances shortest first, including monthly limits without a duration", () => {
    const reading = (bucket: string, label: string, windowMinutes: number): QuotaSample => ({
      ...sample(now, 20),
      agent: "opencode",
      bucket,
      label,
      windowMinutes,
    });
    const readings = [
      reading("monthly", "Monthly", 0),
      reading("other", "Other allowance", 0),
      reading("weekly", "Weekly", 10080),
      reading("review-b", "Code review · Weekly", 10080),
      reading("rolling", "5 hour", 300),
      reading("review-a", "Code review · Weekly", 10080),
      { ...reading("codex-weekly", "Weekly", 10080), agent: "codex" as const },
    ];
    const order = (values: QuotaSample[]) =>
      forecasts(values, [], now).map(({ latest }) => latest.bucket);
    const expected = [
      "rolling",
      "codex-weekly",
      "review-a",
      "review-b",
      "weekly",
      "monthly",
      "other",
    ];
    expect(order(readings)).toEqual(expected);
    expect(order([...readings].reverse())).toEqual(expected);
  });
});
