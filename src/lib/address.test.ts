import { expect, test } from "vite-plus/test";
import { parseSort, sortParam, withParams } from "./address.ts";

test("parameters are set and taken out, and the rest kept", () => {
  const url = new URL("http://app/sessions?agent=codex&q=parser");
  expect(withParams(url, { q: "docs", from: "2026-09-12" })).toBe(
    "/sessions?agent=codex&q=docs&from=2026-09-12",
  );
  expect(withParams(url, { agent: null, q: null })).toBe("/sessions");
});

test("the root of the desktop app, which has no path, is written as one", () => {
  // `goto("")` would stay on `?period=7`, so returning to the default period did nothing.
  const root = new URL("tauri://localhost?period=7");
  expect(root.pathname).toBe("");
  expect(withParams(root, { period: null })).toBe("/");
  expect(withParams(root, { period: "90" })).toBe("/?period=90");
});

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
