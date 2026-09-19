/**
 * A browsable list of sessions.
 *
 * Owned rather than awaited because its pages accumulate as the reader
 * scrolls. The engine answers a filter in a few milliseconds, so this keeps no
 * cursor: it sends the filter and keeps the rows.
 *
 * A failed first read has no rows to show and offers a retry; a failed later
 * page keeps the rows loaded and retries only itself. The engine keeps
 * indexing meanwhile, so rows can shift between two reads: a page leaves out
 * rows already loaded, and the next refresh, which reads every loaded row
 * again, restores the order.
 *
 * Each method untracks its work, since it reads and writes this state and the
 * page calls it from an effect.
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

/** Where a list is in its reading: before its first answer, answered, re-reading, or failed. */
type Phase = "initial" | "ready" | "updating" | "error";

export class SessionList {
  /** Rows loaded so far, in order. */
  sessions = $state.raw<readonly Session[]>([]);
  /** How many sessions match the filter, loaded or not. */
  total = $state(0);
  /** Usage across every match, not only the loaded rows. */
  tokens = $state.raw<Tokens>(NO_TOKENS);
  /** Estimated cost across every match; null when none of it is priced. */
  costUsd = $state<number | null>(null);
  phase = $state<Phase>("initial");
  /** Why the first page failed. */
  error = $state<string | null>(null);
  /** Why a later page failed. */
  pageError = $state<string | null>(null);
  loadingPage = $state(false);

  #filter: Filter = {};
  /** The filter shown, as text, and the index revision it was read at. */
  #shown: string | undefined;
  #revision = 0;
  /** Distinguishes overlapping reads, so a slow one cannot overwrite a newer. */
  #sequence = 0;
  /** The latest read from the top, which a later page must follow. */
  #reading: Promise<void> = Promise.resolve();

  get complete(): boolean {
    return this.sessions.length >= this.total;
  }

  /**
   * Show what a filter matches as of an index revision: a new filter from its
   * first page, and a new revision by reading the loaded rows again. Showing
   * what is already shown reads nothing.
   */
  show(filter: Filter, revision: number): void {
    untrack(() => {
      const shown = JSON.stringify(filter);
      if (shown !== this.#shown) {
        this.#shown = shown;
        this.#filter = filter;
        void this.#read(PAGE_SIZE);
      } else if (revision !== this.#revision) {
        void this.refresh();
      }
      this.#revision = revision;
    });
  }

  /**
   * Read the filter again, as many rows as are loaded, so that a list
   * scrolled far down keeps its length and its place.
   */
  refresh(): Promise<void> {
    return untrack(() => this.#read(Math.max(PAGE_SIZE, this.sessions.length)));
  }

  /**
   * Replace the rows with `count` from the top, in as few reads as the engine
   * allows. Whatever was answered last stays on screen until this answers, so
   * only a list with no answer yet shows a skeleton.
   */
  #read(count: number): Promise<void> {
    const sequence = ++this.#sequence;
    const answered =
      this.sessions.length > 0 || this.phase === "ready" || this.phase === "updating";
    this.phase = answered ? "updating" : "initial";
    this.pageError = null;
    this.#reading = (async () => {
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
    return this.#reading;
  }

  /**
   * Append the next page, if there is one. It follows the rows loaded when it
   * is read, so it waits for a read from the top still in flight, and is read
   * again if one starts while it is out.
   */
  more(): Promise<void> {
    return untrack(async () => {
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
          } catch (failure) {
            if (sequence !== this.#sequence) continue;
            this.pageError = errorLine(failure);
          }
          return;
        }
      } finally {
        this.loadingPage = false;
      }
    });
  }
}

/** Rows followed by a page, leaving out any row the page repeats. */
function joined(rows: readonly Session[], page: readonly Session[]): readonly Session[] {
  const loaded = new Set(rows.map((row) => row.id));
  return [...rows, ...page.filter((row) => !loaded.has(row.id))];
}
