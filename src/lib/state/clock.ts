/**
 * The time, for labels such as "2 hours ago" that would otherwise go stale
 * without anything on screen suggesting it.
 */
import { createSubscriber } from "svelte/reactivity";

/** Nothing shows seconds, so a faster tick would only draw the same text. */
const TICK_MS = 30_000;

const ticking = createSubscriber((update) => {
  const timer = setInterval(update, TICK_MS);
  return () => clearInterval(timer);
});

/** The current moment, which moves on every thirty seconds in whatever reads it. */
export function now(): Date {
  ticking();
  return new Date();
}
