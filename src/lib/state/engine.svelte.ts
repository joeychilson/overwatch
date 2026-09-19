/**
 * What the engine is doing, for the whole window.
 *
 * One owner holds this: indexing runs in the background and announces itself,
 * and a per-page subscription would drop those notices while navigating. The
 * root layout creates it, starts it once, and puts it in context.
 *
 * `revision` exists so screens can re-read when the index changes without
 * having to understand what changed. It is a counter, not a database revision:
 * anything derived from it simply re-runs. A view of one session that keeps
 * what it read, such as a conversation read a page at a time, watches that
 * session instead, and hears only of changes to it.
 */
import { getContext, setContext } from "svelte";
import { getStatus, onIndexChanged, onSessionsChanged, type Status } from "#lib/api/backend.ts";

const key = Symbol("overwatch.engine");

/** What the engine reports before it has answered for the first time. */
const UNKNOWN: Status = {
  scanning: false,
  filesRead: 0,
  progress: null,
  sessions: 0,
  agents: [],
  problems: [],
  accounts: [],
};

export class Engine {
  /** The engine's last reported state. */
  status = $state<Status>(UNKNOWN);
  /**
   * Bumped whenever the index changes.
   *
   * Screens derive their reads from this, so a conversation finished in
   * another window appears without anyone polling for it.
   */
  revision = $state(0);

  /** What is watching each session for changes, by the session's id. */
  #watching = new Map<string, Set<() => void>>();

  /**
   * Call `handler` whenever a scan reads anything new of a session, until the
   * returned function is called.
   */
  watch(session: string, handler: () => void): () => void {
    const handlers = this.#watching.get(session) ?? new Set();
    handlers.add(handler);
    this.#watching.set(session, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#watching.delete(session);
    };
  }

  /**
   * Read the engine's current state.
   *
   * A failure leaves the last status standing: the engine scans every five
   * seconds and announces each result, so the next notice brings what this
   * could not read.
   */
  async #read(): Promise<void> {
    try {
      this.status = await getStatus();
    } catch {
      // The next announced scan brings the status instead.
    }
  }

  /**
   * Subscribe to index changes and read the first status.
   *
   * Returns the teardown; the owner must call it. Outside Tauri the
   * subscription never establishes and the teardown is a no-op.
   */
  start(): () => void {
    const unlisten: (() => void)[] = [];
    let stopped = false;
    const keep = (subscribed: Promise<() => void>) =>
      void subscribed.then((stop) => {
        if (stopped) stop();
        else unlisten.push(stop);
      });
    keep(
      onIndexChanged((status) => {
        const grew = status.sessions !== this.status.sessions;
        this.status = status;
        // A scan that parsed nothing changed nothing, so screens holding
        // results are not asked to re-read for it.
        if (grew || status.filesRead > 0) this.revision += 1;
      }),
    );
    keep(
      onSessionsChanged((ids) => {
        for (const id of ids) for (const handler of this.#watching.get(id) ?? []) handler();
      }),
    );
    void this.#read();
    return () => {
      stopped = true;
      // Teardown must not depend on the subscriptions unwinding cleanly.
      for (const stop of unlisten) void Promise.resolve(stop()).catch(() => undefined);
    };
  }
}

/** Publish the window's engine state to every descendant. */
export function setEngine(engine: Engine): Engine {
  return setContext(key, engine);
}

/** The window's engine state, as published by the root layout. */
export function getEngine(): Engine {
  return getContext<Engine>(key);
}
