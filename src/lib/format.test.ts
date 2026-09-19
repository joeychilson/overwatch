import { describe, expect, test } from "vite-plus/test";
import {
  UNKNOWN,
  formatCount,
  formatCountCompact,
  formatCountdown,
  formatDay,
  formatDays,
  formatDuration,
  formatElapsed,
  formatPercent,
  formatProject,
  formatRelative,
  formatSpan,
  formatWhen,
  formatTime,
  formatUsd,
  projectName,
} from "./format.ts";

describe("counts", () => {
  test("groups thousands", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1_048_576)).toBe("1,048,576");
    expect(formatCount(60_290_890)).toBe("60,290,890");
  });

  test("distinguishes an unknown value from zero", () => {
    expect(formatCount(null)).toBe(UNKNOWN);
    expect(formatCount(undefined)).toBe(UNKNOWN);
    expect(formatCount(0)).toBe("0");
  });
});

describe("compact counts", () => {
  test("scales to the right magnitude", () => {
    expect(formatCountCompact(999)).toBe("999");
    expect(formatCountCompact(1_200)).toBe("1.2K");
    expect(formatCountCompact(1_200_000)).toBe("1.2M");
    expect(formatCountCompact(2_625_402)).toBe("2.6M");
    expect(formatCountCompact(2_861_772_645)).toBe("2.9B");
    expect(formatCountCompact(1.5e12)).toBe("1.5T");
  });

  test("drops the decimal above a hundred so columns stay aligned", () => {
    expect(formatCountCompact(150_000)).toBe("150K");
    expect(formatCountCompact(99_900)).toBe("99.9K");
  });

  test("keeps the sign", () => {
    expect(formatCountCompact(-1_200)).toBe("-1.2K");
  });
});

describe("money", () => {
  test("shows cents", () => {
    expect(formatUsd(42.27413)).toBe("$42.27");
    expect(formatUsd(1560.89)).toBe("$1,560.89");
    expect(formatUsd(0)).toBe("$0.00");
  });

  test("does not round a real cost down to nothing", () => {
    // A session that cost something must never read as free.
    expect(formatUsd(0.004598)).toBe("$0.0046");
    expect(formatUsd(0.0001)).toBe("$0.0001");
  });

  test("an unrecorded cost is unknown, not zero", () => {
    expect(formatUsd(null)).toBe(UNKNOWN);
  });
});

describe("percentages", () => {
  test("round to whole percents", () => {
    expect(formatPercent(67)).toBe("67%");
    expect(formatPercent(40.6)).toBe("41%");
    expect(formatPercent(null)).toBe(UNKNOWN);
  });
});

describe("durations", () => {
  test("scales its units", () => {
    expect(formatDuration(0.25)).toBe("250ms");
    expect(formatDuration(2.34)).toBe("2.3s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(3_480)).toBe("58m 0s");
    // 3,840 seconds is 64 minutes, which belongs in hours, not minutes.
    expect(formatDuration(3_840)).toBe("1h 4m");
    expect(formatDuration(5_400)).toBe("1h 30m");
    expect(formatDuration(200_000)).toBe("2d 7h");
  });

  test("rejects a nonsensical span", () => {
    expect(formatDuration(-1)).toBe(UNKNOWN);
    expect(formatDuration(Number.NaN)).toBe(UNKNOWN);
  });

  test("elapsed needs both ends", () => {
    const start = 1_789_169_902_696;
    expect(formatElapsed(start, start + 5_400_000)).toBe("1h 30m");
    expect(formatElapsed(start, null)).toBe(UNKNOWN);
    expect(formatElapsed(null, start)).toBe(UNKNOWN);
    // A session with one exchange took no measurable time; that is not unknown.
    expect(formatElapsed(start, start)).toBe("0ms");
  });

  test("a countdown is to the minute, rounded up", () => {
    const now = 1_789_169_902_696;
    expect(formatCountdown(now + 30_000, now)).toBe("1m");
    expect(formatCountdown(now + 44 * 60_000 + 1_000, now)).toBe("45m");
    expect(formatCountdown(now + 72 * 60_000, now)).toBe("1h 12m");
    expect(formatCountdown(now + (3 * 24 + 4) * 3_600_000, now)).toBe("3d 4h");
  });
});

describe("days", () => {
  const now = new Date(2026, 8, 13);

  test("name the year only when it is not this one", () => {
    expect(formatDay(new Date(2026, 8, 12).getTime(), false, now)).toBe("Sep 12");
    expect(formatDay(new Date(2026, 8, 12).getTime(), true, now)).toBe("Sat, Sep 12");
    expect(formatDay(new Date(2025, 8, 12).getTime(), false, now)).toBe("Sep 12, 2025");
  });

  test("a run of days says what its ends share once", () => {
    const plain = (text: string) => text.replaceAll(/\s/g, " ");
    const day = (month: number, date: number) => new Date(2026, month, date).getTime();
    expect(formatDays(day(8, 12), day(8, 12), now)).toBe("Sat, Sep 12");
    expect(plain(formatDays(day(8, 6), day(8, 12), now))).toBe("Sep 6 – 12");
    expect(plain(formatDays(day(7, 30), day(8, 5), now))).toBe("Aug 30 – Sep 5");
  });
});

describe("recent work", () => {
  // A Sunday afternoon.
  const now = new Date(2026, 8, 13, 15);
  const plain = (text: string) => text.replaceAll(/\s/g, " ");

  test("says when as briefly as is still clear", () => {
    expect(plain(formatWhen(new Date(2026, 8, 13, 9, 5).getTime(), now))).toBe("9:05 AM");
    expect(formatWhen(new Date(2026, 8, 12, 23).getTime(), now)).toBe("Yesterday");
    expect(formatWhen(new Date(2026, 8, 8, 12).getTime(), now)).toBe("Tuesday");
    expect(formatWhen(new Date(2026, 8, 1, 12).getTime(), now)).toBe("Sep 1");
  });
});

describe("times", () => {
  const now = new Date(2026, 8, 13);
  const plain = (text: string) => text.replaceAll(/\s/g, " ");

  test("a span says what its ends share once", () => {
    const start = new Date(2026, 8, 1, 17, 24).getTime();
    expect(plain(formatTime(start))).toBe("5:24 PM");
    expect(plain(formatSpan(start, new Date(2026, 8, 1, 18).getTime(), now))).toBe(
      "Sep 1, 5:24 – 6:00 PM",
    );
    expect(plain(formatSpan(start, new Date(2026, 8, 2, 9).getTime(), now))).toBe(
      "Sep 1, 5:24 PM – Sep 2, 9:00 AM",
    );
  });
});

describe("relative time", () => {
  const now = new Date("2026-09-12T12:00:00Z");

  test("names the largest fitting unit", () => {
    expect(formatRelative(now.getTime() - 30_000, now)).toBe("just now");
    expect(formatRelative(now.getTime() - 2 * 3_600_000, now)).toBe("2 hours ago");
    expect(formatRelative(now.getTime() - 3 * 24 * 3_600_000, now)).toBe("3 days ago");
  });

  test("has nothing to say about a missing instant", () => {
    expect(formatRelative(null, now)).toBe(UNKNOWN);
  });
});

describe("projects", () => {
  test("names a directory the way a person would", () => {
    expect(projectName("/Users/me/Workspace/overwatch")).toBe("overwatch");
    expect(formatProject("/Users/me/Workspace/overwatch")).toBe("Workspace/overwatch");
    expect(formatProject("/Users/me/Workspace/overwatch", 3)).toBe("me/Workspace/overwatch");
  });

  test("handles a missing or root directory", () => {
    expect(projectName(null)).toBe(UNKNOWN);
    expect(formatProject(null)).toBe(UNKNOWN);
    expect(projectName("/")).toBe("/");
  });
});
