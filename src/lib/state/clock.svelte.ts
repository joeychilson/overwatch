/**
 * A coarse shared clock for relative times.
 *
 * Relative labels such as "2 hours ago" go stale silently, which is worse than
 * a wrong number because nothing on screen suggests it. One ticking value keeps
 * every such label honest, and one interval does it for the whole window rather
 * than one per row.
 *
 * The tick is deliberately coarse. Nothing here shows seconds, so a faster
 * clock would only re-render the same text.
 */
import { getContext, setContext } from "svelte";

const key = Symbol("overwatch.clock");

/** How often the clock advances. */
const TICK_MS = 30_000;

export class Clock {
  /** The current moment, updated on each tick. */
  now = $state(new Date());

  /** Begin ticking. Returns the teardown; the owner must call it. */
  start(): () => void {
    const timer = setInterval(() => {
      this.now = new Date();
    }, TICK_MS);
    return () => clearInterval(timer);
  }
}

/** Publish the window's clock to every descendant. */
export function setClock(clock: Clock): Clock {
  return setContext(key, clock);
}

/** The window's clock, as published by the root layout. */
export function getClock(): Clock {
  return getContext<Clock>(key);
}
