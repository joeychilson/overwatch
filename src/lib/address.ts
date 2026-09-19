/**
 * What a page is showing, kept in its address, so that opening a result and
 * going back returns to exactly what was on screen.
 */

/** How a control changes the address: in place, keeping focus and scroll. */
export const REPLACE = { replace: true, reset: false } as const;

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
