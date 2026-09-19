<script lang="ts">
  /**
   * The conversation itself.
   *
   * The first page is an `await` in the boundary below, which owns the first
   * load and its failure. What follows accumulates, so it belongs to a
   * conversation made from that page; another session reads another first
   * page, which makes another conversation.
   *
   * The find bar belongs to the conversation it steps through, so a search the
   * page opened with, as from a link, goes to what it found once there is
   * somewhere to go.
   */
  import { onDestroy } from "svelte";
  import { closeTranscript, getTranscript } from "#lib/api/backend.ts";
  import Failure from "#lib/components/ui/Failure.svelte";
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

  // The engine holds the parsed conversation, which can be large, for paging.
  onDestroy(() => void closeTranscript().catch(() => {}));
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
    <Failure title="Could not read this conversation." {error} onretry={reset} retry="Try again" />
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
