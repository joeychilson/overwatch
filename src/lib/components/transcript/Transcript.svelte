<script lang="ts">
  /**
   * The conversation itself.
   *
   * The first page is an `await` inside the boundary below, so Svelte owns the
   * first load and its failure. What comes after it — later pages, reading as
   * far as a turn the timeline chose, and a live session's newest turns —
   * accumulates rather than replaces, so it belongs to a conversation made from
   * that page. Changing session reads another first page, which makes another
   * conversation, and the turns drawn from it start afresh.
   *
   * The find bar belongs to the conversation it steps through, so it opens
   * with the turns it can bring into view, and a search the page opened with,
   * as from a link, goes to what it found as soon as there is somewhere to go.
   */
  import { onMount } from "svelte";
  import { closeTranscript, getTranscript } from "#lib/api/backend.ts";
  import { errorLine } from "#lib/errors.ts";
  import { Conversation, PAGE_SIZE } from "#lib/state/conversation.svelte.ts";
  import FindBar from "./FindBar.svelte";
  import Turns from "./Turns.svelte";

  interface Props {
    sessionId: string;
    /** Who the model's turns are attributed to, such as `Codex`. */
    agent: string;
    /** What is being found in the conversation; null while the find bar is closed. */
    finding: string | null;
    /** Keep a new search. */
    onquery: (query: string) => void;
    /** Close the find bar. */
    onclose: () => void;
  }

  let { sessionId, agent, finding, onquery, onclose }: Props = $props();

  let turns = $state<ReturnType<typeof Turns>>();
  let bar = $state<ReturnType<typeof FindBar>>();

  /**
   * Bring a turn into view, reading as far as it first. Before the first page
   * has arrived there is nothing to bring it into, and nothing happens.
   */
  export function reveal(index: number) {
    void turns?.reveal(index);
  }

  /** Put the cursor in the find bar, once it is open. */
  export function find(): Promise<void> {
    return bar?.focus() ?? Promise.resolve();
  }

  /** Move to the next turn found, or the one before. */
  export function step(direction: 1 | -1) {
    bar?.step(direction);
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
  {@const conversation = new Conversation(sessionId, first)}
  {#key conversation}
    {#if finding !== null}
      <FindBar
        bind:this={bar}
        session={sessionId}
        query={finding}
        {onquery}
        onreveal={(index) => void turns?.reveal(index, true)}
        {onclose}
      />
    {/if}
    <Turns bind:this={turns} {conversation} {agent} highlight={finding} />
  {/key}
</svelte:boundary>
