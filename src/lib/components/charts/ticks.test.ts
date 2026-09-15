import { expect, test } from "vite-plus/test";
import { tickLabel, ticks } from "./ticks.ts";

test("steps are round and reach the largest value", () => {
  expect(ticks(3_078_000)).toEqual([0, 1_000_000, 2_000_000, 3_000_000, 4_000_000]);
  expect(ticks(9.5)).toEqual([0, 2.5, 5, 7.5, 10]);
  expect(ticks(4_000)).toEqual([0, 1_000, 2_000, 3_000, 4_000]);
});

test("an empty chart still has an axis", () => {
  expect(ticks(0)).toEqual([0, 1]);
});

test("labels drop what a round step does not need", () => {
  expect(tickLabel(0, false)).toBe("0");
  expect(tickLabel(2_000_000, false)).toBe("2M");
  expect(tickLabel(2_500, false)).toBe("2.5K");
  expect(tickLabel(2.5, true)).toBe("$2.5");
  expect(tickLabel(0.25, true)).toBe("$0.25");
  expect(tickLabel(10_000, true)).toBe("$10K");
});
