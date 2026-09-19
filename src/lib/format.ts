/**
 * Presentation of the engine's values.
 *
 * Unknown is not zero: a value the engine could not establish renders as
 * {@link UNKNOWN}, so a recorded zero stays distinguishable from an absent one.
 */

import { addDays, startOfDay } from "./periods.ts";

/** What every function shows when a value was not established. */
export const UNKNOWN = "—";

/** A number the engine may or may not have established. */
type Maybe = number | null | undefined;

/** Whether a value is a number worth showing. */
function known(value: Maybe): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** An exact count with thousands separators, such as `1,048,576`. */
export function formatCount(value: Maybe): string {
  if (!known(value)) return UNKNOWN;
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

const MAGNITUDES: readonly (readonly [string, number])[] = [
  ["T", 1e12],
  ["B", 1e9],
  ["M", 1e6],
  ["K", 1e3],
];

/**
 * A short count for dense columns, such as `1.2M`.
 *
 * One decimal below a hundred of a unit and none above it, so a column of these
 * stays the same width whatever the magnitudes in it are.
 */
export function formatCountCompact(value: Maybe): string {
  if (!known(value)) return UNKNOWN;
  const sign = value < 0 ? "-" : "";
  const size = Math.abs(value);
  for (const [suffix, magnitude] of MAGNITUDES) {
    if (size >= magnitude) {
      const scaled = size / magnitude;
      return `${sign}${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}${suffix}`;
    }
  }
  return `${sign}${Math.round(size)}`;
}

/**
 * Money, to the cent, such as `$42.27`.
 *
 * Amounts under a cent that are not zero show more places rather than rounding
 * to `$0.00`, because a session that cost something should not read as free.
 */
export function formatUsd(value: Maybe): string {
  if (!known(value)) return UNKNOWN;
  const size = Math.abs(value);
  const places = size > 0 && size < 0.01 ? 4 : 2;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/** What a view of usage counts. */
export type Measure = "tokens" | "cost";

/** An amount of usage for a dense column: tokens compactly, or money to the cent. */
export function formatMeasure(value: Maybe, measure: Measure): string {
  return measure === "cost" ? formatUsd(value) : formatCountCompact(value);
}

/** A whole percentage, such as `67%`. */
export function formatPercent(value: Maybe): string {
  if (!known(value)) return UNKNOWN;
  return `${value.toFixed(0)}%`;
}

/** A Unix millisecond instant as a `Date`, or null when there is none. */
function instant(at: Maybe): Date | null {
  if (!known(at) || at === 0) return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A date and time in the reader's own zone. */
export function formatDateTime(at: Maybe): string {
  const date = instant(at);
  if (!date) return UNKNOWN;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * A calendar day, such as `Sep 12` or `Sat, Sep 12`, with the year only when it
 * is not this one.
 */
export function formatDay(at: Maybe, weekday = false, now: Date = new Date()): string {
  const date = instant(at);
  if (!date) return UNKNOWN;
  return date.toLocaleDateString(undefined, {
    weekday: weekday ? "short" : undefined,
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/**
 * The calendar days from `from` through `to`, such as `Sat, Sep 12` or
 * `Sep 6 – 12`, with the year only when an end is not in this one.
 */
export function formatDays(from: number, to: number, now: Date = new Date()): string {
  const last = Math.max(from, to);
  if (last === from) return formatDay(from, true, now);
  const thisYear = [from, last].every((day) => new Date(day).getFullYear() === now.getFullYear());
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: thisYear ? undefined : "numeric",
  }).formatRange(from, last);
}

/**
 * When something last happened, as briefly as is still clear: a time today,
 * `Yesterday`, a weekday within the week, and a date before that.
 */
export function formatWhen(at: Maybe, now: Date = new Date()): string {
  const date = instant(at);
  if (!date) return UNKNOWN;
  const today = startOfDay(now.getTime());
  if (date.getTime() >= today) return formatTime(at);
  if (date.getTime() >= addDays(today, -1)) return "Yesterday";
  if (date.getTime() >= addDays(today, -6)) {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }
  return formatDay(at, false, now);
}

/** The hour an instant starts, such as `3 PM`. */
export function formatHour(at: Maybe): string {
  const date = instant(at);
  if (!date) return UNKNOWN;
  return date.toLocaleTimeString(undefined, { hour: "numeric" });
}

/**
 * The hours from the one starting at `from` through the one starting at `to`,
 * such as `2 – 3 PM`, with the day unless it is today's.
 */
export function formatHours(from: number, to: number, now: Date = new Date()): string {
  const today = startOfDay(from) === startOfDay(now.getTime());
  return new Intl.DateTimeFormat(undefined, {
    month: today ? undefined : "short",
    day: today ? undefined : "numeric",
    year: new Date(from).getFullYear() === now.getFullYear() ? undefined : "numeric",
    hour: "numeric",
  }).formatRange(from, Math.max(from, to) + 3_600_000);
}

/** A time of day in the reader's own zone, such as `5:24 PM`. */
export function formatTime(at: Maybe): string {
  const date = instant(at);
  if (!date) return UNKNOWN;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * When something ran, such as `Sep 1, 5:24 – 6:00 PM`, saying what the two ends
 * share once, and the year only when it is not this one.
 */
export function formatSpan(from: Maybe, to: Maybe, now: Date = new Date()): string {
  const start = instant(from);
  const end = instant(to);
  if (!start || !end) return UNKNOWN;
  const thisYear =
    start.getFullYear() === now.getFullYear() && end.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: thisYear ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).formatRange(start, end < start ? start : end);
}

const RELATIVE: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

/** How long ago something happened, such as `2 hours ago`. */
export function formatRelative(at: Maybe, now: Date = new Date()): string {
  const date = instant(at);
  if (!date) return UNKNOWN;
  const difference = date.getTime() - now.getTime();
  const size = Math.abs(difference);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, span] of RELATIVE) {
    if (size >= span) return format.format(Math.round(difference / span), unit);
  }
  return "just now";
}

/**
 * How long a session ran, such as `1h 4m`.
 *
 * Zero is a real answer here — a session with one exchange took no measurable
 * time — so it reads as `0s` rather than as unknown.
 */
export function formatElapsed(from: Maybe, to: Maybe): string {
  const start = instant(from);
  const end = instant(to);
  if (!start || !end) return UNKNOWN;
  const seconds = Math.max(0, (end.getTime() - start.getTime()) / 1000);
  return formatDuration(seconds);
}

/** A span of seconds, such as `1h 4m` or `2.3s`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return UNKNOWN;
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * How long until an instant, to the minute, such as `45m` or `1h 12m`.
 *
 * Rounded up and never below a minute, so a countdown does not reach zero
 * early; seconds are left out because the window's clock ticks every thirty.
 */
export function formatCountdown(to: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((to - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The trailing segments of a working directory, such as `Workspace/overwatch`. */
export function formatProject(cwd: string | null | undefined, segments = 2): string {
  if (!cwd) return UNKNOWN;
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  return parts.slice(-segments).join("/");
}

/** The last segment of a working directory, which is what people call it. */
export function projectName(cwd: string | null | undefined): string {
  if (!cwd) return UNKNOWN;
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "/";
}
