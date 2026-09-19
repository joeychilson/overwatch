/**
 * What a page is showing, kept in its address.
 *
 * A search, an ordering or a period held only by a component is lost the
 * moment someone opens a result and comes back. Kept in the address, it
 * survives that, and going back returns to exactly what was on screen.
 */

/** How a control changes the address: in place, keeping focus and scroll. */
export const REPLACE = { replace: true, reset: false } as const;

/** An ordering of rows by one of their columns. */
export interface Ordering<K extends string> {
  key: K;
  descending: boolean;
}

/**
 * The path of an address, which is empty at the root of the desktop app:
 * `tauri://localhost` has a scheme without special rules, so it has no `/`.
 */
export function pathOf(url: Pick<URL, "pathname">): string {
  return url.pathname || "/";
}

/** An address with some parameters set, and those given as null taken out. */
export function withParams(
  url: Pick<URL, "pathname" | "search">,
  changes: Record<string, string | null>,
): string {
  const params = new URLSearchParams(url.search);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  const query = params.toString();
  // Never an empty address, which would name the current page, query and all.
  return query === "" ? pathOf(url) : `${pathOf(url)}?${query}`;
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
