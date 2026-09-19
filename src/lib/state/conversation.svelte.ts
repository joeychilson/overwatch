/**
 * One session's conversation, as far as it has been read.
 *
 * Owned rather than awaited because its pages accumulate, and because a live
 * session's newest turns are read again as its agent adds to them. The first
 * page is still an `await`, in the boundary that creates this from it.
 *
 * Reads run one at a time, in the order they were asked for, since each
 * changes the turns the next continues from. Each method untracks its work,
 * since it reads and writes this state.
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
 * tool's result lands in its call's turn, which is among the newest while the
 * agent waits for it.
 */
const TAIL = 100;

/** Every turn of a session, without drawing any of them. */
export async function allTurns(session: string): Promise<Turn[]> {
  const turns: Turn[] = [];
  for (let total = Infinity; turns.length < total;) {
    const read = await getTranscript(session, turns.length, LARGEST_PAGE);
    total = read.total;
    if (read.turns.length === 0) break;
    turns.push(...read.turns);
  }
  return turns;
}

export class Conversation {
  readonly session: string;
  /** Turns read so far, from the first, in order. */
  turns = $state.raw<readonly Turn[]>([]);
  /** How many turns the session has, read or not. */
  total = $state(0);
  /** Why the last page failed; the turns already read are unaffected. */
  failure = $state<string | null>(null);
  #loading = $state(0);

  #queue: Promise<unknown> = Promise.resolve();
  /** Whether a read of the newest turns is waiting its turn; it serves every change until it runs. */
  #following = false;

  constructor(session: string, first: Transcript) {
    this.session = session;
    this.turns = first.turns;
    this.total = first.total;
  }

  get complete(): boolean {
    return this.turns.length >= this.total;
  }

  /** Whether a page, or a read as far as a turn, is in flight. */
  get loading(): boolean {
    return this.#loading > 0;
  }

  /** Append the next page, unless one is already coming or there is none. */
  more(): Promise<void> {
    return untrack(() =>
      this.loading || this.complete ? Promise.resolve() : this.#load(() => this.#append(PAGE_SIZE)),
    );
  }

  /** Read as far as a turn and a page past it, answering whether it has been read. */
  reach(index: number): Promise<boolean> {
    return untrack(async () => {
      if (index < this.turns.length) return true;
      await this.#load(async () => {
        while (this.turns.length <= index && !this.complete) {
          if ((await this.#append(index + PAGE_SIZE - this.turns.length)) === 0) break;
        }
      });
      return index < this.turns.length;
    });
  }

  /**
   * Read the newest turns again after the session changed, answering how many
   * were added to those read.
   *
   * A reader who has read to the end is given what the agent added and the
   * newest turns as they now stand; one who has not only learns how far the
   * session now goes, and reaches its end by paging. A failure leaves what was
   * read for the next change to try again.
   */
  follow(): Promise<number> {
    return untrack(async () => {
      if (this.#following) return 0;
      this.#following = true;
      try {
        return await this.#serially(async () => {
          this.#following = false;
          const read = this.turns.length;
          if (read < this.total) {
            this.total = (await getTranscript(this.session, read, 1)).total;
            return 0;
          }
          const from = Math.max(0, read - TAIL);
          const newest = await getTranscript(this.session, from, LARGEST_PAGE);
          this.turns = [
            ...this.turns.slice(0, from),
            ...kept(this.turns.slice(from), newest.turns),
          ];
          this.total = newest.total;
          return this.turns.length - read;
        });
      } catch {
        return 0;
      }
    });
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

  #serially<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/**
 * Turns read again, each unchanged one kept as the object already shown, so
 * that what is on screen is not drawn again for nothing.
 */
function kept(shown: readonly Turn[], read: readonly Turn[]): Turn[] {
  const before = new Map(shown.map((turn) => [turn.index, turn]));
  return read.map((turn) => {
    const old = before.get(turn.index);
    return old !== undefined && same(old, turn) ? old : turn;
  });
}

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
