import { expect, test } from "vite-plus/test";
import { parseSort, sortParam, sorted, toggled } from "./sort.ts";

test("an ordering is written only when it is not the usual one", () => {
  const keys = ["updated", "tokens", "title"] as const;
  const newest = { key: "updated", descending: true } as const;
  expect(parseSort("-tokens", keys, newest)).toEqual({ key: "tokens", descending: true });
  expect(parseSort("title", keys, newest)).toEqual({ key: "title", descending: false });
  expect(parseSort("-nonsense", keys, newest)).toBe(newest);
  expect(parseSort(null, keys, newest)).toBe(newest);

  expect(sortParam({ key: "tokens", descending: true }, newest)).toBe("-tokens");
  expect(sortParam({ key: "updated", descending: true }, newest)).toBeNull();
});

test("a column is chosen the way it reads first, and turned round when chosen again", () => {
  const largestFirst = new Set(["tokens"] as const);
  const byTitle = { key: "title", descending: false } as const;
  expect(toggled<"title" | "tokens">(byTitle, "tokens", largestFirst)).toEqual({
    key: "tokens",
    descending: true,
  });
  expect(toggled<"title" | "tokens">(byTitle, "title", largestFirst)).toEqual({
    key: "title",
    descending: true,
  });
});

test("an unknown value sorts below every known one, either way round", () => {
  const rows = [
    { name: "b", cost: 2 },
    { name: "none", cost: null },
    { name: "a", cost: 0 },
  ];
  const cost = (row: (typeof rows)[number]) => row.cost;
  expect(sorted(rows, cost, true).map((row) => row.name)).toEqual(["b", "a", "none"]);
  expect(sorted(rows, cost, false).map((row) => row.name)).toEqual(["none", "a", "b"]);
  expect(sorted(rows, (row) => row.name, false).map((row) => row.name)).toEqual(["a", "b", "none"]);
});
