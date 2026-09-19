import { expect, test } from "vite-plus/test";
import { columns, hours } from "./columns.ts";

test("a month is drawn a day to a column", () => {
  const now = new Date(2026, 8, 13, 15).getTime();
  const laid = columns(new Date(2026, 7, 15, 9).getTime(), now);
  expect(laid.grain).toBe("day");
  expect(laid.starts).toHaveLength(30);
  expect(laid.of(new Date(2026, 8, 13, 1).getTime())).toBe(29);
  expect(laid.of(new Date(2026, 6, 1).getTime())).toBeUndefined();
});

test("a longer span is drawn a week to a column", () => {
  const now = new Date(2026, 8, 13).getTime();
  const laid = columns(new Date(2025, 8, 13).getTime(), now);
  expect(laid.grain).toBe("week");
  // Sunday to Sunday, so a day and the week it starts share a column.
  expect(laid.of(new Date(2026, 8, 13).getTime())).toBe(laid.starts.length - 1);
});

test("a day is drawn an hour to a column, however long its clocks make it", () => {
  const midnight = new Date(2026, 8, 18).getTime();
  const laid = hours(new Date(2026, 8, 18, 15, 20).getTime());
  expect(laid.grain).toBe("hour");
  expect(laid.starts[0]).toBe(midnight);
  expect(laid.starts).toHaveLength(24);
  expect(laid.of(new Date(2026, 8, 18, 15, 45).getTime())).toBe(15);
  expect(laid.of(new Date(2026, 8, 19, 0, 0).getTime())).toBeUndefined();
  expect(laid.of(midnight - 1)).toBeUndefined();

  // Whatever this machine's zone, a day's hours run from its midnight to the
  // next, one elapsed hour apart, so a day beside a clock change has 23 or 25.
  for (const day of [new Date(2026, 2, 8), new Date(2026, 10, 1), new Date(2026, 2, 29)]) {
    const next = new Date(day);
    next.setDate(day.getDate() + 1);
    const laid = hours(day.getTime());
    expect(laid.starts).toHaveLength((next.getTime() - day.getTime()) / 3_600_000);
    expect(laid.starts.every((start, index) => start === day.getTime() + index * 3_600_000)).toBe(
      true,
    );
  }
});
