import { expect, test } from "vite-plus/test";
import { parsePeriod, periodParam } from "./periods.ts";

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
