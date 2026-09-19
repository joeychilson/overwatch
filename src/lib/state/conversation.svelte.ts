/**
 * One session's conversation, as far as it has been read.
 *
 * Owned rather than awaited, for the two things an `await` does not express:
 * pages accumulate as the reader goes rather than replacing one another, and
 * while the session is live its newest turns are read again as its agent adds
 * to them. The first page is still an `await`, in the boundary that creates
 * this from it, so the first load and its failure belong to that boundary.
 *
 * The engine holds the conversation it parsed, so every read after the first
 * is a slice of it until the session's file changes. Reads run one at a time,
 * in the order they were asked for: each changes the turns the next one
 * continues from. Each method untracks its work, since it reads and writes
 * this state and the page follows a live session from an effect.
 */
import { untrack } from "svelte";
import { getTranscript, type Transcript, type Turn } from "#lib/api/backend.ts";
import { errorLine } from "#lib/errors.ts";

/** How many turns one page carries. */
export const PAGE_SIZE = 150;
/** The most turns the engine hands over at once. */
const LARGEST_PAGE = 2_000;
/**
 * How many of the newest turns are read again when a live session changes. A
 * tool's result is written after its call and lands in the call's turn, which
 * is among the newest while the agent waits for it.
 */
const TAIL = 100;

export class Conversation {
  /** The session it is of. */
  readonly session: string;
  /** Turns read so far, from the first, in order. */
  turns = $state.raw<readonly Turn[]>([]);
  /** How many turns the session has, read or not. */
  total = $state(0);
  /** Why the last page failed; the turns already read are unaffected. */
  failure = $state<string | null>(null);
  /** How many pages, or reads as far as a turn, are in flight. */
  #loading = $state(0);

  #queue: Promise<unknown> = Promise.resolve();
  /** Whether a read of the newest turns is waiting its turn, which serves every change until it runs. */
  #following = false;

  constructor(session: string, first: Transcript) {
    this.session = session;
    this.turns = first.turns;
    this.total = first.total;
  }

  /** Whether every turn has been read. */
  get complete(): boolean {
    return this.turns.length >= this.total;
  }

  /** Whether a page, or a read as far as a turn, is in flight. */
  get loading(): boolean {
    return this.#loading > 0;
  }

  /** Append the next page, unless one is already coming or there is none. */
  more(): Promise<void> {
    return untrack(() => {
      if (this.loading || this.complete) return Promise.resolve();
      return this.#load(() => this.#append(PAGE_SIZE));
    });
  }

  /** Read as far as a turn and a page past it, answering whether it has been read. */
  reach(index: number): Promise<boolean> {
    return untrack(() => this.#reach(index));
  }

  async #reach(index: number): Promise<boolean> {
    if (index < this.turns.length) return true;
    await this.#load(async () => {
      while (this.turns.length <= index && !this.complete) {
        if ((await this.#append(index + PAGE_SIZE - this.turns.length)) === 0) break;
      }
    });
    return index < this.turns.length;
  }

  /**
   * Read the newest turns again, after the session changed while it was open,
   * answering how many were added to those read.
   *
   * A reader who has read to the end is given what the agent added, and the
   * newest turns as they now stand. One who has not only learns how far the
   * session now goes; its end arrives by paging, as the rest did. A failure
   * leaves what was read as it was, for the next change to try again.
   */
  follow(): Promise<number> {
    return untrack(() => this.#follow());
  }

  #follow(): Promise<number> {
    if (this.#following) return Promise.resolve(0);
    this.#following = true;
    return this.#serially(async () => {
      this.#following = false;
      const read = this.turns.length;
      if (read < this.total) {
        this.total = (await getTranscript(this.session, read, 1)).total;
        return 0;
      }
      const from = Math.max(0, read - TAIL);
      const newest = await getTranscript(this.session, from, LARGEST_PAGE);
      this.turns = [...this.turns.slice(0, from), ...kept(this.turns.slice(from), newest.turns)];
      this.total = newest.total;
      return this.turns.length - read;
    }).catch(() => 0);
  }

  /** Read `count` turns after those read, answering how many arrived. */
  async #append(count: number): Promise<number> {
    const next = await getTranscript(
      this.session,
      this.turns.length,
      Math.min(LARGEST_PAGE, count),
    );
    this.turns = [...this.turns, ...next.turns];
    this.total = next.total;
    return next.turns.length;
  }

  /** Run a read in its turn, counting it as loading and keeping why it failed. */
  #load(read: () => Promise<unknown>): Promise<void> {
    this.#loading += 1;
    this.failure = null;
    return this.#serially(async () => {
      try {
        await read();
      } catch (error) {
        this.failure = errorLine(error);
      } finally {
        this.#loading -= 1;
      }
    });
  }

  /** Run reads one after another, each after the last has settled. */
  #serially<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/**
 * Turns read again, each one unchanged kept as the object already shown, so
 * what is on screen is not drawn again for nothing.
 */
function kept(shown: readonly Turn[], read: readonly Turn[]): Turn[] {
  const before = new Map(shown.map((turn) => [turn.index, turn]));
  return read.map((turn) => {
    const old = before.get(turn.index);
    return old !== undefined && same(old, turn) ? old : turn;
  });
}

/** Whether two readings of a turn say the same. */
function same(a: Turn, b: Turn): boolean {
  return (
    a.speaker === b.speaker &&
    a.at === b.at &&
    a.model === b.model &&
    a.text === b.text &&
    a.tool?.name === b.tool?.name &&
    a.tool?.input === b.tool?.input &&
    a.tool?.output === b.tool?.output &&
    a.tool?.failed === b.tool?.failed
  );
}
