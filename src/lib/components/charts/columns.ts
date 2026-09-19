/**
 * The columns a span of time is drawn in: an hour to a column for one day, a
 * day to a column for longer, and a week to a column once a day's column would
 * be too narrow to be seen.
 */
import { HOUR, addDays, startOfDay, startOfWeek } from "#lib/periods.ts";

/** The longest span, in days, drawn a day to a column. */
const DAILY = 120;

/** What one column covers. */
export type Grain = "hour" | "day" | "week";

export interface Columns {
  /** When each column starts, oldest first. */
  starts: number[];
  grain: Grain;
  /** The position of the column an instant falls in, if any. */
  of: (at: number) => number | undefined;
}

/** The columns from the day `first` falls in to the day `now` does. */
export function columns(first: number, now = Date.now()): Columns {
  const today = startOfDay(now);
  const weekly = (today - startOfDay(first)) / 86_400_000 >= DAILY;
  const starts: number[] = [];
  const positions = new Map<number, number>();
  for (
    let start = weekly ? startOfWeek(first) : startOfDay(first);
    start <= today;
    start = addDays(start, weekly ? 7 : 1)
  ) {
    positions.set(start, starts.length);
    starts.push(start);
  }
  return {
    starts,
    grain: weekly ? "week" : "day",
    of: (at) => positions.get(weekly ? startOfWeek(at) : startOfDay(at)),
  };
}

/**
 * The hours of the local day `day` falls in, from its midnight to the next.
 *
 * Hours are counted as elapsed time rather than read off the clock, so a day
 * beside a clock change has 23 or 25 columns, and the hour repeated when the
 * clocks go back is two columns, as the engine counts it.
 */
export function hours(day: number): Columns {
  const start = startOfDay(day);
  const end = addDays(start, 1);
  const starts: number[] = [];
  for (let at = start; at < end; at += HOUR) starts.push(at);
  return {
    starts,
    grain: "hour",
    of: (at) => {
      const position = Math.floor((at - start) / HOUR);
      return position >= 0 && position < starts.length ? position : undefined;
    },
  };
}
