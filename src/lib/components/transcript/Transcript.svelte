<script lang="ts">
  /**
   * The conversation itself.
   *
   * The first page is an `await` inside the boundary below, so Svelte owns the
   * loading, the ordering and the failure. Later pages are different: they
   * accumulate rather than replace, which no derivation expresses, so they are
   * held here and tagged with the session they belong to. That tag is why
   * changing session needs no reset; pages for another session simply do not
   * match and are ignored.
   *
   * The engine parses a conversation once and holds it, so the first page pays
   * for the read and every page after it is a slice. That is also what lets the
   * timeline bring any turn into view: reading as far as it is one more slice.
   */
  import { onMount, tick, untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { closeTranscript, getTranscript, type Turn } from "#lib/api/backend.ts";
  import { errorLine } from "#lib/errors.ts";
  import { formatCount } from "#lib/format.ts";
  import { blocks } from "#lib/transcript.ts";
  import Gathered from "./Gathered.svelte";
  import Message from "./Message.svelte";

  interface Props {
    sessionId: string;
    /** Who the model's turns are attributed to, such as `Codex`. */
    agent: string;
    /**
     * A turn to bring into view. A new object each time, so choosing the same
     * turn again still brings it back.
     */
    target: { index: number } | null;
  }

  let { sessionId, agent, target }: Props = $props();

  /** How many turns one page carries. */
  const PAGE_SIZE = 150;
  /** The most turns the engine hands over at once. */
  const LARGEST_PAGE = 2_000;

  /** Pages read beyond the first, and the session they were read for. */
  let appended = $state.raw<{ session: string; turns: readonly Turn[] }>({
    session: "",
    turns: [],
  });

  let loading = $state(false);
  let failure = $state<string | null>(null);
  /** Runs of steps and notes opened, by session and first turn. */
  const opened = new SvelteSet<string>();
  /** The turn the timeline last brought into view. */
  let revealed = $state<number | null>(null);

  /** Pages already appended for the session on screen, if any. */
  const extra = $derived(appended.session === sessionId ? appended.turns : ([] as readonly Turn[]));

  /** Read the turns from `loaded` on, `count` of them, onto those already here. */
  async function append(count: number) {
    const loaded = PAGE_SIZE + extra.length;
    const next = await getTranscript(sessionId, loaded, Math.min(LARGEST_PAGE, count));
    appended = { session: sessionId, turns: [...extra, ...next.turns] };
    return next.turns.length;
  }

  async function loadMore(total: number) {
    if (loading || PAGE_SIZE + extra.length >= total) return;
    loading = true;
    failure = null;
    try {
      await append(PAGE_SIZE);
    } catch (error) {
      // Every turn already read stays on screen; only this page failed.
      failure = errorLine(error);
    } finally {
      loading = false;
    }
  }

  /** Bring a turn into view, reading as far as it first if it is not here yet. */
  async function reveal(index: number) {
    if (loading) return;
    loading = true;
    failure = null;
    try {
      while (PAGE_SIZE + extra.length <= index) {
        // As far as the turn, and a page past it.
        const loaded = PAGE_SIZE + extra.length;
        if ((await append(index + PAGE_SIZE - loaded)) === 0) break;
      }
    } catch (error) {
      failure = errorLine(error);
      return;
    } finally {
      loading = false;
    }
    revealed = index;
    await tick();
    document
      .getElementById(`turn-${index}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  $effect(() => {
    const chosen = target;
    if (chosen) untrack(() => void reveal(chosen.index));
  });

  /** Load the next page as the end of the loaded turns is reached. */
  function loadOnReach(node: HTMLElement, total: number) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore(total);
    });
    observer.observe(node);
    return {
      update: (next: number) => void (total = next),
      destroy: () => observer.disconnect(),
    };
  }

  // The engine holds the parsed conversation so paging is free; tell it when
  // nobody is reading one any more so that memory goes back.
  onMount(() => () => void closeTranscript().catch(() => undefined));
</script>

<svelte:boundary>
  {#snippet pending()}
    <div class="grid gap-3" aria-hidden="true">
      {#each [0, 1, 2] as row (row)}
        <div class="h-20 animate-pulse rounded-menu bg-hover"></div>
      {/each}
    </div>
  {/snippet}

  {#snippet failed(error, reset)}
    <div class="grid justify-items-start gap-3">
      <p role="alert">Could not read this conversation.</p>
      <code class="text-meta text-muted">{errorLine(error)}</code>
      <button class="h-9 rounded-control bg-active px-3" onclick={() => reset()}>Try again</button>
    </div>
  {/snippet}

  {@const first = await getTranscript(sessionId, 0, PAGE_SIZE)}
  {@const loaded = first.turns.length + extra.length}

  {#if loaded === 0}
    <p class="text-muted">This session recorded nothing readable.</p>
  {:else}
    <div class="grid grid-cols-[minmax(0,1fr)] gap-3">
      {#each blocks([...first.turns, ...extra]) as block (block.index)}
        {#if block.kind === "message"}
          <Message
            turn={block.turn}
            {agent}
            dated={block.dated}
            revealed={revealed === block.index}
          />
        {:else}
          {@const key = `${sessionId}:${block.index}`}
          {@const holds = block.turns.some((turn) => turn.index === revealed)}
          {@const open = opened.has(key) || holds}
          <Gathered
            turns={block.turns}
            {open}
            {revealed}
            ontoggle={() => {
              if (!open) opened.add(key);
              else {
                opened.delete(key);
                if (holds) revealed = null;
              }
            }}
          />
        {/if}
      {/each}
    </div>

    <div use:loadOnReach={first.total} class="h-px"></div>

    {#if failure !== null}
      <div class="mt-4 grid justify-items-start gap-2">
        <code class="text-meta text-muted" role="alert">{failure}</code>
        <button
          class="h-9 rounded-control bg-active px-3"
          onclick={() => void loadMore(first.total)}
        >
          Retry loading more
        </button>
      </div>
    {:else if loading}
      <p class="mt-4 text-meta text-muted">Loading more of the conversation…</p>
    {:else if loaded < first.total}
      <p class="mt-4 text-meta text-muted">
        Showing {formatCount(loaded)} of {formatCount(first.total)} turns.
      </p>
    {/if}
  {/if}
</svelte:boundary>
