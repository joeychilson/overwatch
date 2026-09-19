/**
 * Who carries out a command from the app's menu.
 *
 * The root layout hears every command. A page that does something of its own
 * with one takes it while it is on screen — a session's page finds within its
 * conversation — and the layout does what the command means everywhere else.
 */
import { getContext, setContext } from "svelte";
import type { Command } from "./api/backend.ts";

const key = Symbol("overwatch.commands");

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

/** Publish the window's commands to every descendant. */
export function setCommands(commands: Commands): Commands {
  return setContext(key, commands);
}

/** The window's commands, as published by the root layout. */
export function getCommands(): Commands {
  return getContext<Commands>(key);
}
