/**
 * A browsable list of sessions.
 *
 * The engine answers a filter with one indexed query in well under a
 * millisecond, so this holds no view, no cursor and no pinned revision: it
 * sends the filter, keeps the rows, and sends it again when something changes.
 * Pages accumulate rather than replace, which is the one thing no derivation
 * expresses and the only reason this is a class rather than an `await` in a
 * component.
 *
 * Two failures are kept apart because they need different recoveries. A failed
 * first page has no rows to show and offers a retry; a failed later page keeps
 * every row already loaded and retries only that page.
 */
import {
  listSessions,
  type Filter,
  type Session,
  type Sort,
  type Tokens,
} from "#lib/api/backend.ts";
import { errorLine } from "#lib/errors.ts";

/** How many rows one page carries. */
const PAGE_SIZE = 100;

/** Where a list is in its reading. */
type Phase = "initial" | "ready" | "updating" | "error";

/** The default ordering: newest first, which is what someone opens the list for. */
export const NEWEST_FIRST: Sort = { key: "updated", descending: true };

/** The default period: all of history, so an old conversation can still be found. */
export const ALL_TIME = null;

const NO_TOKENS: Tokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
};

export class SessionList {
  /** Rows loaded so far, in order. */
  sessions = $state.raw<readonly Session[]>([]);
  /** How many sessions match the filter, loaded or not. */
  total = $state(0);
  /** Usage across every match, not only the loaded rows. */
  tokens = $state<Tokens>(NO_TOKENS);
  /** Estimated cost across every match; null when none of it is priced. */
  costUsd = $state<number | null>(null);
  /** Where the list is in its reading. */
  phase = $state<Phase>("initial");
  /** Why the first page failed, when it did. */
  error = $state<string | null>(null);
  /** Why a later page failed; the loaded rows are unaffected. */
  pageError = $state<string | null>(null);
  /** Whether a later page is in flight. */
  loadingPage = $state(false);

  #filter: Filter = { sort: NEWEST_FIRST };
  /** Distinguishes overlapping reads, so a slow one cannot overwrite a newer. */
  #sequence = 0;

  /** Whether every matching row has been loaded. */
  get complete(): boolean {
    return this.sessions.length >= this.total;
  }

  /**
   * Read the first page for a filter, replacing whatever is loaded.
   *
   * Called by whichever handler changed a control, and once on mount. Reading
   * is work a person asked for, so it belongs where they asked for it.
   */
  async apply(filter: Filter): Promise<void> {
    this.#filter = { sort: NEWEST_FIRST, ...filter };
    const sequence = ++this.#sequence;
    this.phase = this.sessions.length > 0 ? "updating" : "initial";
    this.pageError = null;
    try {
      const page = await listSessions({ ...this.#filter, offset: 0, limit: PAGE_SIZE });
      if (sequence !== this.#sequence) return;
      this.sessions = page.sessions;
      this.total = page.total;
      this.tokens = page.tokens;
      this.costUsd = page.costUsd;
      this.error = null;
      this.phase = "ready";
    } catch (failure) {
      if (sequence !== this.#sequence) return;
      this.error = errorLine(failure);
      this.phase = "error";
    }
  }

  /** Read the filter again, keeping the rows on screen until it answers. */
  refresh(): Promise<void> {
    return this.apply(this.#filter);
  }

  /** Append the next page, if there is one. */
  async more(): Promise<void> {
    if (this.loadingPage || this.complete || this.phase === "initial") return;
    const sequence = this.#sequence;
    this.loadingPage = true;
    this.pageError = null;
    try {
      const page = await listSessions({
        ...this.#filter,
        offset: this.sessions.length,
        limit: PAGE_SIZE,
      });
      // A filter change while this was in flight makes the page meaningless.
      if (sequence !== this.#sequence) return;
      this.sessions = [...this.sessions, ...page.sessions];
      this.total = page.total;
    } catch (failure) {
      if (sequence === this.#sequence) this.pageError = errorLine(failure);
    } finally {
      if (sequence === this.#sequence) this.loadingPage = false;
    }
  }

  /** Try the last failed page again. */
  retryPage(): Promise<void> {
    this.pageError = null;
    return this.more();
  }
}
