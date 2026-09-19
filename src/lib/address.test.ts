import { expect, test } from "vite-plus/test";
import { withParams } from "./address.ts";

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
