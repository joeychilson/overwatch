/**
 * The engine's side of the IPC boundary, in a browser.
 *
 * `vp run demo` builds the window against this module in place of
 * `@tauri-apps/api`, so every command is answered from the same made-up
 * history the screenshots are drawn from, and the pages can be walked through
 * — filtered, sorted, paged, read — with nothing native present. It stands
 * exactly where Tauri's transport does, which is where the Playwright suite
 * and the screenshots put their stand-ins too, so the window above it is the
 * real one and no module under `src/` knows the difference. `vite.config.ts`
 * makes the swap for that run alone, and it cannot reach a build.
 *
 * The clock is moved rather than stopped, so the history's last day is today
 * however long after it was written the demo runs, and relative times go on
 * ticking as they would on a real machine.
 */
import { NOW, answer } from "./history.ts";

/**
 * How long an answer is held.
 *
 * About what a warm engine takes, so the first load, the pending updates after
 * it, and everything they reveal are what a reader would really see.
 */
const LATENCY_MS = 90;

/** How far the history sits from this machine's clock. */
const skew = NOW - Date.now();
const real = Date.now.bind(Date);
Date.now = () => real() + skew;
// The bare constructor reads the clock itself rather than `Date.now`, so it is
// answered from the moved one; every other signature is built as it was.
globalThis.Date = new Proxy(Date, {
  construct: (target, args) =>
    args.length === 0 ? new target(target.now()) : Reflect.construct(target, args),
});

/** Answer one command from the history, as the engine would. */
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
  try {
    return answer(command, args) as T;
  } catch (error) {
    // The only thing the history refuses is a session it does not hold, which
    // the engine reports the same way.
    throw { kind: "not_found", message: error instanceof Error ? error.message : String(error) };
  }
}

/** What a caller runs to stop listening. */
export type UnlistenFn = () => void;

/** The history never changes underfoot, so a listener hears nothing and its teardown does nothing. */
export function listen<T>(
  _event: string,
  _handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  return Promise.resolve(() => undefined);
}
