/** Repeatable randomness for the sample history, so every run draws the same one. */

/** A repeatable number in [0, 1) for `seed`. */
export function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/** One of `items`, chosen repeatably by `seed`. */
export function pick<T>(items: readonly T[], seed: number): T {
  const item = items[Math.floor(noise(seed) * items.length)];
  if (item === undefined) throw new Error("Cannot pick from an empty list");
  return item;
}
