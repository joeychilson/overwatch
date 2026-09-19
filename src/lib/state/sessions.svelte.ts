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
 *
 * The engine keeps indexing while the list is open, so rows can shift between
 * two reads. A page that repeats a row already loaded leaves it out, and the
 * next refresh, which reads every loaded row again, restores the order.
 *
 * Every method reads and writes the list's own state, and the page refreshes
 * from an effect, so each one untracks its work: an effect calling it must
 * depend only on what the effect itself reads.
 */
import { untrack } from "svelte";
import {
  listSessions,
  type Filter,
  type Session,
  type SessionPage,
  type Sort,
  type Tokens,
} from "#lib/api/backend.ts";
import { errorLine } from "#lib/errors.ts";

/** How many rows one page carries. */
const PAGE_SIZE = 100;
/** The most rows the engine returns for one read. */
const LARGEST_PAGE = 500;

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
  /** The latest read of the list from its top, which a later page must follow. */
  #reading: Promise<void> = Promise.resolve();

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
  apply(filter: Filter): Promise<void> {
    this.#filter = { sort: NEWEST_FIRST, ...filter };
    return untrack(() => this.#read(PAGE_SIZE));
  }

  /**
   * Read the filter again, keeping the rows on screen until it answers.
   *
   * It reads as many rows as are loaded, so a list scrolled far down keeps its
   * length, and its place, when the engine finds new work.
   */
  refresh(): Promise<void> {
    return untrack(() => this.#read(Math.max(PAGE_SIZE, this.sessions.length)));
  }

  /**
   * Read `count` rows from the top, in as few reads as the engine allows, and
   * replace the rows with them.
   *
   * Whatever the list last answered stays on screen until this answers, an
   * empty answer included, so a refresh never flashes a skeleton; only a list
   * with no answer to show starts over from one.
   */
  #read(count: number): Promise<void> {
    const sequence = ++this.#sequence;
    const answered =
      this.sessions.length > 0 || this.phase === "ready" || this.phase === "updating";
    this.phase = answered ? "updating" : "initial";
    this.pageError = null;
    const reading = (async () => {
      try {
        let rows: readonly Session[] = [];
        let offset = 0;
        let page: SessionPage;
        do {
          const limit = Math.min(LARGEST_PAGE, count - offset);
          page = await listSessions({ ...this.#filter, offset, limit });
          if (sequence !== this.#sequence) return;
          rows = joined(rows, page.sessions);
          offset += page.sessions.length;
        } while (offset < count && offset < page.total && page.sessions.length > 0);
        this.sessions = rows;
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
    })();
    this.#reading = reading;
    return reading;
  }

  /**
   * Append the next page, if there is one.
   *
   * A page follows the rows loaded when it is read, so it waits for a read
   * from the top that is still in flight, and is read again if one starts
   * while it is out: arriving first, it would be replaced along with the rows
   * it followed.
   */
  more(): Promise<void> {
    return untrack(() => this.#more());
  }

  async #more(): Promise<void> {
    if (this.loadingPage) return;
    this.loadingPage = true;
    this.pageError = null;
    try {
      for (;;) {
        while (this.phase === "initial" || this.phase === "updating") await this.#reading;
        if (this.complete || this.sessions.length === 0) return;
        const sequence = this.#sequence;
        try {
          const page = await listSessions({
            ...this.#filter,
            offset: this.sessions.length,
            limit: PAGE_SIZE,
          });
          if (sequence !== this.#sequence) continue;
          this.sessions = joined(this.sessions, page.sessions);
          this.total = page.total;
          return;
        } catch (failure) {
          if (sequence !== this.#sequence) continue;
          this.pageError = errorLine(failure);
          return;
        }
      }
    } finally {
      this.loadingPage = false;
    }
  }

  /** Try the last failed page again. */
  retryPage(): Promise<void> {
    this.pageError = null;
    return this.more();
  }
}

/** Rows followed by a page, leaving out any row the page repeats. */
function joined(rows: readonly Session[], page: readonly Session[]): readonly Session[] {
  const loaded = new Set(rows.map((row) => row.id));
  return [...rows, ...page.filter((row) => !loaded.has(row.id))];
}
