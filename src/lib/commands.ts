/**
 * Who carries out a command from the app's menu.
 *
 * The root layout hears every command. A page that does something of its own
 * with one takes it while it is on screen, as a session's page takes Find, and
 * the layout does what the command means everywhere else.
 */
import { createContext } from "svelte";
import type { Command } from "./api/backend.ts";

export class Commands {
  #taken = new Map<Command, () => void>();

  /** Carry out a command in place of the layout, until the returned function is called. */
  take(command: Command, handler: () => void): () => void {
    this.#taken.set(command, handler);
    return () => {
      if (this.#taken.get(command) === handler) this.#taken.delete(command);
    };
  }

  /** Carry out a command if a page has taken it, answering whether one had. */
  run(command: Command): boolean {
    const handler = this.#taken.get(command);
    handler?.();
    return handler !== undefined;
  }
}

export const [getCommands, setCommands] = createContext<Commands>();
