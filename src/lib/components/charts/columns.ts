/**
 * The columns a span of days is drawn in: one a day, or one a week once the
 * span is too long for a day's column to be seen.
 */
import { addDays, startOfDay, startOfWeek } from "#lib/periods.ts";

/** The longest span, in days, drawn a day to a column. */
const DAILY = 120;

export interface Columns {
  /** When each column starts, oldest first. */
  starts: number[];
  weekly: boolean;
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
    weekly,
    of: (at) => positions.get(weekly ? startOfWeek(at) : startOfDay(at)),
  };
}
