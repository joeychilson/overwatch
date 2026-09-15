import { expect, test } from "vite-plus/test";
import { columns } from "./columns.ts";

test("a month is drawn a day to a column", () => {
  const now = new Date(2026, 8, 13, 15).getTime();
  const laid = columns(new Date(2026, 7, 15, 9).getTime(), now);
  expect(laid.weekly).toBe(false);
  expect(laid.starts).toHaveLength(30);
  expect(laid.of(new Date(2026, 8, 13, 1).getTime())).toBe(29);
  expect(laid.of(new Date(2026, 6, 1).getTime())).toBeUndefined();
});

test("a longer span is drawn a week to a column", () => {
  const now = new Date(2026, 8, 13).getTime();
  const laid = columns(new Date(2025, 8, 13).getTime(), now);
  expect(laid.weekly).toBe(true);
  // Sunday to Sunday, so a day and the week it starts share a column.
  expect(laid.of(new Date(2026, 8, 13).getTime())).toBe(laid.starts.length - 1);
});
