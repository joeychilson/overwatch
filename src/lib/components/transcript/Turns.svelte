<script lang="ts">
  /**
   * A conversation's turns, as far as they have been read.
   *
   * What was said reads in full and the steps between gather into blocks, as
   * `blocks` lays them out. The next page is read as the end of what has been
   * read comes into view, and {@link reveal} reads as far as a turn and brings
   * it into view for whoever chose it.
   *
   * The session is watched while it is on screen: whenever a scan reads
   * anything new of it, its newest turns are read again. A reader already at
   * the bottom stays there as they arrive, as in a terminal; one reading
   * further up is left where they are and told there is more below.
   */
  import { onMount, tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import type { Conversation } from "#lib/state/conversation.svelte.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { formatCount } from "#lib/format.ts";
  import { blocks } from "#lib/transcript.ts";
  import Gathered from "./Gathered.svelte";
  import Message from "./Message.svelte";

  interface Props {
    conversation: Conversation;
    /** Who the model's turns are attributed to, such as `Codex`. */
    agent: string;
  }

  let { conversation, agent }: Props = $props();

  const engine = getEngine();

  /** How near the bottom, in pixels, still counts as at it. */
  const NEAR = 48;

  /** Runs of steps and notes opened, by first turn. */
  const opened = new SvelteSet<number>();
  /** The turn last brought into view. */
  let revealed = $state<number | null>(null);
  /** Whether turns arrived below while the reader was further up. */
  let unseen = $state(false);

  /** The page's scrolling area, which the conversation scrolls within. */
  function scroller() {
    return document.getElementById("main-content");
  }

  function atBottom() {
    const area = scroller();
    return area !== null && area.scrollHeight - area.scrollTop - area.clientHeight < NEAR;
  }

  /** Bring a turn into view, reading as far as it first if it has not been read. */
  export async function reveal(index: number) {
    if (!(await conversation.reach(index))) return;
    revealed = index;
    await tick();
    document
      .getElementById(`turn-${index}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /** Read what the agent added, keeping a reader at the bottom there. */
  async function catchUp() {
    const pinned = atBottom();
    const added = await conversation.follow();
    if (added <= 0) return;
    if (!pinned) {
      unseen = true;
      return;
    }
    await tick();
    const area = scroller();
    area?.scrollTo({ top: area.scrollHeight });
  }

  /** Go to the newest turn, reading as far as it. */
  async function latest() {
    unseen = false;
    await conversation.reach(conversation.total - 1);
    await tick();
    const area = scroller();
    area?.scrollTo({ top: area.scrollHeight, behavior: "smooth" });
  }

  onMount(() => {
    const stopWatching = engine.watch(conversation.session, () => void catchUp());
    // Reaching the bottom by any means shows what the notice was about.
    const area = scroller();
    const settle = () => {
      if (unseen && atBottom()) unseen = false;
    };
    area?.addEventListener("scroll", settle, { passive: true });
    return () => {
      stopWatching();
      area?.removeEventListener("scroll", settle);
    };
  });

  /** Load the next page as the end of the turns read comes into view. */
  function loadOnReach(node: HTMLElement) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void conversation.more();
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
</script>

{#if conversation.turns.length === 0}
  <p class="text-muted">This session recorded nothing readable.</p>
{:else}
  <div class="grid grid-cols-[minmax(0,1fr)] gap-3">
    {#each blocks(conversation.turns) as block (block.index)}
      {#if block.kind === "message"}
        <Message
          turn={block.turn}
          {agent}
          dated={block.dated}
          revealed={revealed === block.index}
        />
      {:else}
        {@const holds = block.turns.some((turn) => turn.index === revealed)}
        {@const open = opened.has(block.index) || holds}
        <Gathered
          turns={block.turns}
          {open}
          {revealed}
          ontoggle={() => {
            if (!open) opened.add(block.index);
            else {
              opened.delete(block.index);
              if (holds) revealed = null;
            }
          }}
        />
      {/if}
    {/each}
  </div>

  <div use:loadOnReach class="h-px"></div>

  {#if conversation.failure !== null}
    <div class="mt-4 grid justify-items-start gap-2">
      <code class="text-meta text-muted" role="alert">{conversation.failure}</code>
      <button class="h-9 rounded-control bg-active px-3" onclick={() => void conversation.more()}>
        Retry loading more
      </button>
    </div>
  {:else if conversation.loading}
    <p class="mt-4 text-meta text-muted">Loading more of the conversation…</p>
  {:else if !conversation.complete}
    <p class="mt-4 text-meta text-muted">
      Showing {formatCount(conversation.turns.length)} of {formatCount(conversation.total)} turns.
    </p>
  {/if}
{/if}

{#if unseen}
  <!-- Held at the foot of the view while there is more below than is in sight. -->
  <div class="pointer-events-none sticky bottom-4 flex justify-center">
    <button
      class="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-border bg-menu px-3 text-meta shadow-[0_8px_30px_#00000018,0_2px_6px_#0000000a] hover:bg-hover"
      onclick={latest}
    >
      <ArrowDown size={14} aria-hidden="true" />
      <span>Newer turns</span>
    </button>
  </div>
{/if}
