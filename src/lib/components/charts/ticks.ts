import { formatCountCompact } from "#lib/format.ts";

/**
 * Round steps for a value axis from zero past `max`, about `count` of them.
 *
 * Steps are 1, 2, 2.5 or 5 of a power of ten, so the labels read as round
 * numbers at any magnitude.
 */
export function ticks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((multiple) => multiple * power).find((step) => step >= rough) ??
    10 * power;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, index) => index * step);
}

/** A tick's label, as short as a round step allows, such as `2M` or `$2.5`. */
export function tickLabel(value: number, money: boolean): string {
  const short =
    value >= 1000 ? formatCountCompact(value).replace(".0", "") : String(Number(value.toFixed(2)));
  return money ? `$${short}` : short;
}
