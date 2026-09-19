<script lang="ts">
  /**
   * Finding within a conversation.
   *
   * A search is something asked for, and answering one means taking the reader
   * to what it found, so it runs in what asks for it: typing that has settled,
   * Return, the menu's Find Next and Find Previous, and once when the bar opens
   * with a search already in it, as from a link. The engine searches the
   * conversation it holds. When a scan reads anything new of the session the
   * search runs again, staying on the turn it was on while that is still found.
   *
   * Return steps forward through what was found, Shift-Return back, and Escape
   * closes the bar. It holds its place at the top of the view while the
   * conversation scrolls beneath it.
   */
  import { onMount, tick } from "svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";
  import { findInTranscript } from "#lib/api/backend.ts";
  import { errorLine } from "#lib/errors.ts";
  import { formatCount } from "#lib/format.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";

  interface Props {
    session: string;
    /** The search as the page's address holds it, which the bar opens with. */
    query: string;
    /** Keep a new search, once typing has settled. */
    onquery: (query: string) => void;
    /** Bring a found turn into view. */
    onreveal: (index: number) => void;
    onclose: () => void;
  }

  let { session, query, onquery, onreveal, onclose }: Props = $props();

  const engine = getEngine();

  /** How long typing settles before it is searched for. */
  const SETTLE_MS = 150;

  const STEP =
    "grid size-7 place-items-center rounded-item text-muted hover:bg-hover hover:text-text disabled:opacity-40 disabled:hover:bg-transparent";

  /** What is in the box, which follows the address until something is typed. */
  let typed = $derived(query);
  let input = $state<HTMLInputElement>();
  /** The last search answered, and the turns it found. */
  let found = $state.raw<{ query: string; turns: readonly number[] } | null>(null);
  /** The found turn last brought into view. */
  let current = $state<number | null>(null);
  let searching = $state(false);
  /** Why the last search failed, if it did. */
  let problem = $state<string | null>(null);

  /** Distinguishes overlapping searches, so a slow one cannot overwrite a newer. */
  let sequence = 0;
  let settling: ReturnType<typeof setTimeout> | undefined;

  const count = $derived(found?.turns.length ?? 0);
  const position = $derived(current === null ? -1 : (found?.turns.indexOf(current) ?? -1));
  const said = $derived.by(() => {
    if (found === null) return searching ? "Finding…" : "";
    if (count === 0) return "No matches";
    return position === -1
      ? `${formatCount(count)} found`
      : `${formatCount(position + 1)} of ${formatCount(count)}`;
  });

  /**
   * Search the conversation, answering with the turns found, or null when the
   * search failed or a later one overtook it.
   */
  async function search(sought: string): Promise<readonly number[] | null> {
    const asked = ++sequence;
    problem = null;
    if (sought === "") {
      found = null;
      searching = false;
      return [];
    }
    searching = true;
    try {
      const turns = await findInTranscript(session, sought);
      if (asked !== sequence) return null;
      found = { query: sought, turns };
      return turns;
    } catch (error) {
      if (asked === sequence) problem = errorLine(error);
      return null;
    } finally {
      if (asked === sequence) searching = false;
    }
  }

  /** Search for something new, and go to the first turn it finds. */
  async function seek(sought: string) {
    const turns = await search(sought.trim());
    if (turns !== null) go(turns[0]);
  }

  /** The same search again, after the session changed underneath it. */
  async function again() {
    if (found === null) return;
    const turns = await search(found.query);
    if (turns !== null && current !== null && !turns.includes(current)) current = null;
  }

  function go(index: number | undefined) {
    current = index ?? null;
    if (index !== undefined) onreveal(index);
  }

  /** Move to the next turn found, or the one before, going round at either end. */
  export function step(direction: 1 | -1) {
    const turns = found?.turns ?? [];
    if (turns.length === 0) return;
    const from = position === -1 ? (direction === 1 ? -1 : 0) : position;
    go(turns[(from + direction + turns.length) % turns.length]);
  }

  /** Put the cursor in the box with what is there selected, ready to search again. */
  export async function focus() {
    await tick();
    input?.focus();
    input?.select();
  }

  /** Search for what was typed, now rather than once typing settles. */
  function submit() {
    clearTimeout(settling);
    onquery(typed);
    void seek(typed);
  }

  function keys(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (typed.trim() !== (found?.query ?? "")) submit();
      else step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
  }

  onMount(() => {
    if (query.trim() !== "") void seek(query);
    const stopWatching = engine.watch(session, () => void again());
    return () => {
      stopWatching();
      clearTimeout(settling);
    };
  });
</script>

<div
  class="sticky top-0 z-20 mb-4 flex h-11 items-center gap-2 rounded-control border border-border bg-menu pr-1 pl-3 shadow-[0_8px_30px_#00000010,0_2px_6px_#00000008]"
  role="search"
  aria-label="Find in conversation"
>
  <Search class="shrink-0 text-muted" size={15} aria-hidden="true" />
  <input
    class="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
    type="search"
    placeholder="Find in conversation"
    aria-label="Find in conversation"
    bind:this={input}
    bind:value={typed}
    oninput={() => {
      clearTimeout(settling);
      settling = setTimeout(submit, SETTLE_MS);
    }}
    onkeydown={keys}
  />
  {#if problem !== null}
    <span class="min-w-0 truncate text-meta text-danger" role="alert" title={problem}>
      Could not search
    </span>
    <button class="shrink-0 rounded-item px-2 text-meta hover:bg-hover" onclick={submit}>
      Retry
    </button>
  {:else}
    <span class="shrink-0 text-meta text-muted tabular-nums" role="status" aria-busy={searching}>
      {said}
    </span>
  {/if}
  <span class="flex shrink-0 items-center">
    <button
      class={STEP}
      aria-label="Previous match"
      title="Previous match (⇧⌘G)"
      disabled={count === 0}
      onclick={() => step(-1)}
    >
      <ChevronUp size={15} aria-hidden="true" />
    </button>
    <button
      class={STEP}
      aria-label="Next match"
      title="Next match (⌘G)"
      disabled={count === 0}
      onclick={() => step(1)}
    >
      <ChevronDown size={15} aria-hidden="true" />
    </button>
  </span>
  <button
    class="grid size-7 shrink-0 place-items-center rounded-item text-muted hover:bg-hover hover:text-text"
    aria-label="Close find"
    title="Close (Esc)"
    onclick={onclose}
  >
    <X size={15} aria-hidden="true" />
  </button>
</div>
