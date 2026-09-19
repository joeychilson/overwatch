/**
 * What the engine is doing, for the whole window.
 *
 * The root layout owns the one instance, so that no notice is missed while
 * pages change.
 */
import { createContext } from "svelte";
import { getStatus, onIndexChanged, onSessionsChanged, type Status } from "#lib/api/backend.ts";

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
  status = $state.raw<Status>(UNKNOWN);
  /**
   * Bumped whenever a scan reads something new. A read of the index takes it
   * as an argument, so that it runs again when the index changes.
   */
  revision = $state(0);

  #watching = new Map<string, Set<() => void>>();

  /** Call `handler` whenever a scan reads anything new of a session, until the returned function is called. */
  watch(session: string, handler: () => void): () => void {
    const handlers = this.#watching.get(session) ?? new Set();
    handlers.add(handler);
    this.#watching.set(session, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#watching.delete(session);
    };
  }

  /** Follow the engine, answering the teardown. */
  start(): () => void {
    const stops = [
      onIndexChanged((status) => {
        const grew = status.sessions !== this.status.sessions;
        this.status = status;
        // Limits are announced with the last scan's status; only a scan that
        // read something makes anything worth reading again.
        if (grew || status.filesRead > 0) this.revision += 1;
      }),
      onSessionsChanged((ids) => {
        for (const id of ids) for (const handler of this.#watching.get(id) ?? []) handler();
      }),
    ];
    // A failure leaves the status to the next announced scan, as does an
    // answer that arrives after one.
    getStatus().then(
      (status) => {
        if (this.status === UNKNOWN) this.status = status;
      },
      () => {},
    );
    return () => stops.forEach((stop) => stop());
  }
}

export const [getEngine, setEngine] = createContext<Engine>();
