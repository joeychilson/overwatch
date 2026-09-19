/**
 * A search of what was said in every conversation.
 *
 * Owned rather than awaited, because its answer accumulates: the engine reads
 * the agents' own files newest first and hands over what it finds a batch at
 * a time, so the sessions found appear while the rest are still being read.
 * The list orders them as it orders its own rows.
 *
 * Asked for from the handlers that change what the list shows, as the list
 * itself is, so it holds the search it last ran and running it again for the
 * same search does nothing. Each method untracks its work, since it reads and
 * writes this state.
 */
import { untrack } from "svelte";
import {
  searchConversations,
  stopSearching,
  type Filter,
  type Mention,
  type Searched,
} from "#lib/api/backend.ts";
import { errorLine } from "#lib/errors.ts";

/** Where a search is. */
type Phase = "idle" | "searching" | "done" | "error";

export class ConversationSearch {
  /** The sessions found so far, in the order they turned up. */
  mentions = $state.raw<readonly Mention[]>([]);
  /** How far the finished search got; null until it has. */
  searched = $state.raw<Searched | null>(null);
  phase = $state<Phase>("idle");
  /** Why the search failed, when it did. */
  error = $state<string | null>(null);

  /** Distinguishes overlapping searches, so a slow one cannot add to a newer. */
  #sequence = 0;
  /** The search last run, so running the same one again does nothing. */
  #asked: string | undefined;

  /** Search for `query` among the sessions `filter` matches, unless that is the search shown. */
  run(query: string, filter: Filter): Promise<void> {
    return untrack(() => this.#run(query.trim(), filter));
  }

  /** Stop a search still running and forget it, as when the list goes back to titles. */
  stop(): void {
    untrack(() => {
      if (this.#asked === undefined && this.phase === "idle") return;
      if (this.phase === "searching") void stopSearching().catch(() => undefined);
      this.#sequence += 1;
      this.#asked = undefined;
      this.mentions = [];
      this.searched = null;
      this.phase = "idle";
    });
  }

  async #run(query: string, filter: Filter): Promise<void> {
    const asked = JSON.stringify([query, filter]);
    if (asked === this.#asked) return;
    this.#asked = asked;
    const sequence = ++this.#sequence;
    this.mentions = [];
    this.searched = null;
    this.error = null;
    if (query === "") {
      this.phase = "idle";
      return;
    }
    this.phase = "searching";
    try {
      const searched = await searchConversations(query, filter, (batch) => {
        if (sequence !== this.#sequence) return;
        this.mentions = [...this.mentions, ...batch];
      });
      if (sequence !== this.#sequence) return;
      this.searched = searched;
      this.phase = "done";
    } catch (failure) {
      if (sequence !== this.#sequence) return;
      // A failed search is run again when asked for again.
      this.#asked = undefined;
      this.error = errorLine(failure);
      this.phase = "error";
    }
  }
}
