/** Orderings of rows by one of their columns, as the address writes them. */

/** An ordering of rows by one of their columns. */
export interface Ordering<K extends string> {
  key: K;
  descending: boolean;
}

/**
 * An ordering from an address's `sort`, such as `-tokens` for the most first,
 * or the fallback when it names no known column.
 */
export function parseSort<K extends string>(
  value: string | null,
  keys: readonly K[],
  fallback: Ordering<K>,
): Ordering<K> {
  const descending = value?.startsWith("-") ?? false;
  const key = keys.find((known) => known === value?.slice(descending ? 1 : 0));
  return key === undefined ? fallback : { key, descending };
}

/** How an address writes an ordering, or null for the fallback, which it leaves out. */
export function sortParam<K extends string>(
  sort: Ordering<K>,
  fallback: Ordering<K>,
): string | null {
  if (sort.key === fallback.key && sort.descending === fallback.descending) return null;
  return `${sort.descending ? "-" : ""}${sort.key}`;
}

/** The ordering a column gets when first chosen: another way round when already chosen. */
export function toggled<K extends string>(
  sort: Ordering<K>,
  key: K,
  descendingFirst: ReadonlySet<K>,
): Ordering<K> {
  return sort.key === key
    ? { key, descending: !sort.descending }
    : { key, descending: descendingFirst.has(key) };
}

/**
 * Rows in the order of a value each has, text alphabetically. A null value is
 * unknown, such as the cost of unpriced usage, and sorts below every known one
 * rather than as zero. The sort is stable.
 */
export function sorted<T>(
  rows: readonly T[],
  value: (row: T) => number | string | null,
  descending: boolean,
): T[] {
  const direction = descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x === null || y === null) return x === y ? 0 : direction * (x === null ? -1 : 1);
    return direction * (typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y));
  });
}
