/// <reference types="node" />
import { addDays } from "date-fns";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  aggregate,
  emptyTokens,
  knownCost,
  priceLookup,
  tokenCost,
  totalTokens,
} from "./analytics";
import { parseCatalog } from "../models/catalog";
import { csv } from "../export";
import { forecasts } from "./forecast";
import type { AccountStatus, QuotaSample, Session } from "../bindings";

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

describe("usage accounting", () => {
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
  it("groups local calendar days across DST boundaries and out-of-order responses", () => {
    for (const month of [2, 10]) {
      const boundary = new Date(2026, month, month === 2 ? 8 : 1);
      const start = boundary.getTime();
      const end = addDays(boundary, 1).getTime();
      const times = [start, end - 1, start + 3600000, start - 1, end, start];
      const session = {
        id: "dates",
        agent: "pi",
        usage: times.map((timestamp) => ({
          timestamp,
          model: "test",
          provider: "lab",
          tokens: { ...emptyTokens(), input: 10 },
          reportedCost: 1,
        })),
      } as Session;
      const stats = aggregate([session], models, start, end);
      expect(stats.total).toBe(40);
      expect(stats.cost).toBe(4);
      expect(stats.days.size).toBe(1);
      const all = aggregate([session], models);
      expect([...all.days.values()].map((point) => point.total)).toEqual([40, 10, 10]);
      expect(all.total).toBe(60);
      expect(all.sessionIds).toEqual(["dates"]);
      if (Intl.DateTimeFormat().resolvedOptions().timeZone === "America/Chicago")
        expect((end - start) / 3600000).toBe(month === 2 ? 23 : 25);
    }
  });
  it("validates catalog fields rather than accepting cast data", () => {
    expect(() =>
      parseCatalog({
        lab: { name: "Lab", models: { bad: { id: "bad", name: "Bad", cost: { input: "2" } } } },
      }),
    ).toThrow("validation");
    expect(() => parseCatalog({})).toThrow();
  });
  it("uses usage timestamps and retains explicitly reported zero cost", () => {
    const timestamp = new Date("2026-08-20T12:00:00").getTime();
    const session: Session = {
      id: "s",
      agent: "pi",
      title: "Session",
      cwd: "/work/project",
      project: "project",
      model: "test",
      startedAt: timestamp - 86400000,
      updatedAt: timestamp,
      messages: 1,
      turns: 1,
      compactions: 0,
      tokens: emptyTokens(),
      usage: [
        {
          timestamp,
          model: "test",
          provider: "lab",
          tokens: { ...emptyTokens(), input: 100 },
          reportedCost: 0,
        },
      ],
      tools: [],
      limits: [],
      sourcePath: "/fixture",
      parentId: null,
      warnings: [],
    };
    const stats = aggregate([session], models, timestamp - 1, timestamp + 1);
    expect(stats.total).toBe(100);
    expect(stats.sessionIds).toEqual(["s"]);
    expect(aggregate([session], models, timestamp + 1, timestamp + 100).sessionIds).toEqual([]);
    expect(stats.cost).toBe(0);
    expect(stats.unpriced).toBe(0);
    expect([...stats.days.keys()]).toEqual(["2026-08-20"]);
    expect(aggregate([session], models, 0, timestamp).total).toBe(0);
    const usage = session.usage[0];
    const mixed = aggregate(
      [
        {
          ...session,
          usage: [
            usage,
            { ...usage, reportedCost: 4 },
            { ...usage, reportedCost: null, tokens: { ...emptyTokens(), input: 1_000_000 } },
            { ...usage, reportedCost: null, model: "unknown" },
            { ...usage, reportedCost: null, model: "unknown", tokens: emptyTokens() },
          ],
        },
      ],
      models,
    );
    expect(mixed.sessionIds).toEqual(["s"]);
    expect(mixed.recordedCost).toBe(4);
    expect(mixed.estimatedCost).toBe(2);
    expect(mixed.cost).toBe(6);
    expect(mixed.pricedCalls).toBe(3);
    expect(mixed.unpricedCalls).toBe(2);
    expect(mixed.unpriced).toBe(100);
    expect(knownCost(mixed)).toBe(6);
    expect(knownCost(stats)).toBe(0);
    expect(knownCost(aggregate([], models))).toBeNull();
    expect(
      knownCost(
        aggregate(
          [{ ...session, usage: [{ ...usage, model: "unknown", reportedCost: null }] }],
          models,
        ),
      ),
    ).toBeNull();
    for (const field of [
      "cost",
      "recordedCost",
      "estimatedCost",
      "pricedCalls",
      "unpricedCalls",
    ] as const) {
      expect([...mixed.days.values()].reduce((sum, row) => sum + row[field], 0)).toBe(mixed[field]);
      expect(mixed.models.reduce((sum, row) => sum + row[field], 0)).toBe(mixed[field]);
    }
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
  it("uses regression only with sufficient fresh observations", () => {
    const points = [sample(now - 1800000, 10), sample(now - 900000, 20), sample(now, 30)];
    const [forecast] = forecasts(points, [], now);
    expect(forecast.state).toBe("projected");
    expect(forecast.percentPerHour).toBeCloseTo(40);
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
it("escapes CSV formulas, quotes, and line breaks", () => {
  expect(csv([["=SUM(A1)", "two\nlines", 'a"b', 12, -4]])).toBe(
    '"\'=SUM(A1)","two\nlines","a""b","12","-4"',
  );
});

it("retains undated usage in lifetime totals without inventing calendar activity", () => {
  const timestamp = new Date("2026-09-01T12:00:00").getTime();
  const session = {
    id: "undated",
    agent: "pi",
    usage: [0, -1, NaN, Infinity, 9e15, timestamp].map((timestamp) => ({
      timestamp,
      model: "test",
      provider: "lab",
      tokens: { ...emptyTokens(), input: 100 },
      reportedCost: 1,
    })),
  } as Session;
  const lifetime = aggregate([session], models);
  expect(lifetime.total).toBe(600);
  expect(lifetime.cost).toBe(6);
  expect(lifetime.models[0].calls).toBe(6);
  expect(lifetime.undatedCalls).toBe(5);
  expect(lifetime.undatedTokens).toBe(500);
  expect([...lifetime.days.values()].map((day) => day.total)).toEqual([100]);
  const period = aggregate([session], models, timestamp, timestamp + 1);
  expect(period.total).toBe(100);
  expect(period.cost).toBe(1);
  expect(period.undatedCalls).toBe(5);
  expect(period.sessionIds).toEqual(["undated"]);
  const unknownOnly = aggregate(
    [{ ...session, usage: session.usage.slice(0, 5) }],
    models,
    timestamp,
  );
  expect(unknownOnly.calls).toBe(0);
  expect(unknownOnly.sessionIds).toEqual([]);
  expect(unknownOnly.days.size).toBe(0);
});

it("accounts for every response in a 200,000-response history", () => {
  const catalog = parseCatalog(JSON.parse(readFileSync("public/catalog.json", "utf8")));
  const start = new Date("2026-06-01T00:00:00").getTime();
  const sessions = Array.from({ length: 1000 }, (_, session) => ({
    id: `session-${session}`,
    agent: "codex",
    usage: Array.from({ length: 200 }, (_, response) => ({
      timestamp: start + (session % 90) * 86400000 + response * 60000,
      model: "gpt-6-astra",
      provider: "openai",
      tokens: { ...emptyTokens(), input: 1000, output: 100 },
      reportedCost: null,
    })),
  })) as Session[];
  const timings: number[] = [];
  const report = process.env.OVERWATCH_BENCHMARK_REPORT;
  const repeats = report ? 6 : 1;
  for (let i = 0; i < repeats; i++) {
    const before = performance.now();
    const result = aggregate(sessions, catalog);
    const elapsed = performance.now() - before;
    if (i || repeats === 1) timings.push(elapsed);
    expect(result.calls).toBe(200000);
    expect(result.total).toBe(220000000);
    expect(result.sessionIds).toHaveLength(1000);
  }
  if (report)
    writeFileSync(
      report,
      JSON.stringify({
        catalogModels: catalog.length,
        responses: 200000,
        timings,
        medianMs: [...timings].sort((a, b) => a - b)[2],
      }),
    );
});
