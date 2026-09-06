import { format, formatDistanceToNowStrict } from "date-fns";

const compactFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const integerFormat = new Intl.NumberFormat("en-US");

const currencyFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const smallCurrencyFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

export const compact = (value: number) => compactFormat.format(value);

export const integer = (value: number) => integerFormat.format(value);

export const money = (value: number | null) =>
  value == null
    ? "—"
    : (value > 0 && value < 0.01 ? smallCurrencyFormat : currencyFormat).format(value);

export const day = (timestamp: number | Date) => format(timestamp, "yyyy-MM-dd");

export const hasTimestamp = (timestamp: number) =>
  Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8.64e15;

export const elapsed = (start: number, end: number): number | null =>
  hasTimestamp(start) && hasTimestamp(end) && end >= start ? end - start : null;

export const relative = (timestamp: number) =>
  hasTimestamp(timestamp)
    ? formatDistanceToNowStrict(timestamp, { addSuffix: true })
    : "Not recorded";

export function duration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
