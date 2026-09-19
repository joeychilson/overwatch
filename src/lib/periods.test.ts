import { expect, test } from "vite-plus/test";
import { parseHour, parsePeriod, periodParam } from "./periods.ts";

test("a period round-trips through the address, the default left out", () => {
  expect(parsePeriod("7")).toBe(7);
  expect(parsePeriod("all")).toBeNull();
  expect(parsePeriod(null)).toBe(30);
  expect(parsePeriod("12")).toBe(30);

  expect(periodParam(7)).toBe("7");
  expect(periodParam(null)).toBe("all");
  expect(periodParam(30)).toBeNull();
});

test("a page that opens on all of history leaves that out instead", () => {
  expect(parsePeriod(null, null)).toBeNull();
  expect(parsePeriod("30", null)).toBe(30);

  expect(periodParam(null, null)).toBeNull();
  expect(periodParam(30, null)).toBe("30");
});

test("today is named in the address as a word", () => {
  expect(parsePeriod("today")).toBe(1);
  expect(periodParam(1)).toBe("today");
  expect(periodParam(1, null)).toBe("today");
});

test("an hour in the address is an instant, and nothing else names one", () => {
  expect(parseHour("1789419600000")).toBe(1_789_419_600_000);
  for (const value of [null, "", "-1", "1.5", "1e12", "today", "99999999999999999"]) {
    expect(parseHour(value)).toBeNull();
  }
});
