/** The periods and calendar days a view of usage is cut into, in local time. */

/** Periods offered, in whole days back from now; `null` is all of history. */
export const PERIODS: readonly { value: number | null; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: null, label: "All time" },
];

/** The period a page shows until another is chosen. */
const DEFAULT_PERIOD = 30;

/** A period as an address names it — `7`, `30`, `90` or `all` — or the page's default. */
export function parsePeriod(
  value: string | null,
  fallback: number | null = DEFAULT_PERIOD,
): number | null {
  if (value === "all") return null;
  return PERIODS.find((period) => String(period.value) === value)?.value ?? fallback;
}

/** How an address names a period, or null for the page's default, which it leaves out. */
export function periodParam(
  days: number | null,
  fallback: number | null = DEFAULT_PERIOD,
): string | null {
  if (days === fallback) return null;
  return days === null ? "all" : String(days);
}

/**
 * Local midnight on the first of the last `days` days, today included, or
 * nothing for all of history. Today is the day `now` falls in.
 */
export function periodStart(days: number | null, now = Date.now()): number | undefined {
  return days === null ? undefined : addDays(startOfDay(now), 1 - days);
}

/** Local midnight at the start of the day `at` falls in. */
export function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local midnight `count` calendar days after `day`, across clock changes. */
export function addDays(day: number, count: number): number {
  const date = new Date(day);
  date.setDate(date.getDate() + count);
  return date.getTime();
}

/** Local midnight on the Sunday that starts the week `day` is in. */
export function startOfWeek(day: number): number {
  return startOfDay(addDays(day, -new Date(day).getDay()));
}

/** A day as `YYYY-MM-DD` in local time, for an address. */
export function dayKey(day: number): string {
  const date = new Date(day);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Local midnight on the day a `YYYY-MM-DD` key names, or null when it names none. */
export function parseDayKey(key: string | null): number | null {
  const match = key?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  // A key such as 2026-02-30 rolls over to another day; it names none.
  return dayKey(day) === key ? day : null;
}
