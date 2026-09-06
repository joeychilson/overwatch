import { expect, it } from "vite-plus/test";
import { elapsed, hasTimestamp, relative } from "./format";

it("distinguishes unknown and reversed session times from a recorded zero duration", () => {
  const time = new Date("2026-09-01T12:00:00Z").getTime();
  expect(elapsed(time, time)).toBe(0);
  expect(elapsed(time, time + 100)).toBe(100);
  expect(elapsed(time + 1, time)).toBeNull();
  for (const missing of [0, -1, NaN, Infinity, 9e15]) {
    expect(hasTimestamp(missing)).toBe(false);
    expect(elapsed(missing, time)).toBeNull();
    expect(elapsed(time, missing)).toBeNull();
    expect(relative(missing)).toBe("Not recorded");
  }
});
