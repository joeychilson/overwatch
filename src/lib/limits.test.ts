import { describe, expect, test } from "vite-plus/test";
import type { Account, Limit } from "./api/backend.ts";
import { followed, tightest } from "./limits.ts";

const MINUTE = 60_000;
const NOW = 1_000 * MINUTE;

function limit(name: string, usedPercent: number, overrides: Partial<Limit> = {}): Limit {
  return {
    name,
    scope: null,
    usedPercent,
    resetsAt: NOW + 60 * MINUTE,
    runsOutAt: null,
    ...overrides,
  };
}

function account(id: string, usedAt: number | null, limits: Limit[] = []): Account {
  return {
    id,
    provider: "claude",
    label: null,
    plan: null,
    via: [],
    limits,
    readAt: NOW,
    problem: null,
    usedAt,
  };
}

const ids = (accounts: Account[]) => accounts.map((each) => each.id);

describe("the accounts the menu bar follows", () => {
  test("are those in use, however long ago within the half hour", () => {
    const accounts = [
      account("idle", NOW - 31 * MINUTE),
      account("working", NOW - 5 * MINUTE),
      account("edge", NOW - 30 * MINUTE),
    ];
    expect(ids(followed(accounts, NOW))).toEqual(["working", "edge"]);
  });

  test("are the one used last when none is in use", () => {
    const accounts = [
      account("older", NOW - 3 * 60 * MINUTE),
      account("never", null),
      account("last", NOW - 2 * 60 * MINUTE),
    ];
    expect(ids(followed(accounts, NOW))).toEqual(["last"]);
  });

  test("are every account when none has been used here", () => {
    const accounts = [account("a", null), account("b", null)];
    expect(ids(followed(accounts, NOW))).toEqual(["a", "b"]);
    expect(followed([], NOW)).toEqual([]);
  });
});

describe("an account's tightest limit", () => {
  test("is the limit on all usage with the least left", () => {
    const opus = limit("Weekly", 99, { scope: "Opus" });
    const hours = limit("5 hours", 71);
    const weekly = limit("Weekly", 46);
    expect(tightest(account("a", null, [weekly, opus, hours]), NOW)).toBe(hours);
  });

  test("counts a window that has ended as full again", () => {
    const ended = limit("5 hours", 88, { resetsAt: NOW - MINUTE });
    const weekly = limit("Weekly", 18);
    expect(tightest(account("a", null, [ended, weekly]), NOW)).toBe(weekly);
  });

  test("is none when every limit is on one model", () => {
    expect(tightest(account("a", null, [limit("Weekly", 50, { scope: "Opus" })]), NOW)).toBeNull();
    expect(tightest(account("a", null), NOW)).toBeNull();
  });
});
