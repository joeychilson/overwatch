<script lang="ts">
  /**
   * A conversation's turns, as far as they have been read: what was said in
   * full, and the steps between gathered into blocks. The next page is read as
   * the end comes into view, and what a search looks for is marked wherever it
   * shows.
   *
   * While on screen, the session's newest turns are read again whenever a scan
   * reads anything new of it. A reader at the bottom stays there as they
   * arrive, as in a terminal; one further up is told there is more below.
   */
  import { onMount, tick } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import { on } from "svelte/events";
  import { SvelteSet } from "svelte/reactivity";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import Failure from "#lib/components/ui/Failure.svelte";
  import { onReach } from "#lib/attachments.ts";
  import type { Conversation } from "#lib/state/conversation.svelte.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { formatCount } from "#lib/format.ts";
  import { blocks, findPattern } from "#lib/transcript.ts";
  import Gathered from "./Gathered.svelte";
  import Message from "./Message.svelte";

  interface Props {
    conversation: Conversation;
    /** Who the model's turns are attributed to, such as `Codex`. */
    agent: string;
    /** What a search is looking for, marked wherever it shows. */
    highlight: string | null;
  }

  let { conversation, agent, highlight }: Props = $props();

  const engine = getEngine();

  /** How near the bottom, in pixels, still counts as at it. */
  const NEAR = 48;

  /** Runs of steps and notes opened, by first turn. */
  const opened = new SvelteSet<number>();
  /** The turn last brought into view. */
  let revealed = $state<number | null>(null);
  /** The turn opened to show what a search found in it. */
  let unfolded = $state<number | null>(null);
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

  /**
   * Bring a turn into view, reading as far as it first if it has not been
   * read, and opening it when `open` says a search found something inside.
   */
  export async function reveal(index: number, open = false) {
    if (!(await conversation.reach(index))) return;
    revealed = index;
    unfolded = open ? index : null;
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
    const stopScrolling = area
      ? on(area, "scroll", () => {
          if (unseen && atBottom()) unseen = false;
        })
      : () => {};
    return () => {
      stopWatching();
      stopScrolling();
    };
  });

  /**
   * Mark every place `sought` shows among the turns, and more strongly within
   * the turn at `here`, through the highlight registry, which marks text
   * without changing the page, and follows whatever is drawn next. A WebKit
   * too old to have the registry marks nothing; the chosen turn still stands
   * out.
   */
  function marks(sought: string | null, here: number | null): Attachment<HTMLElement> {
    return (root) => {
      const pattern = findPattern(sought ?? "");
      if (pattern === null || !("highlights" in CSS)) return;
      const mark = () => {
        const within = here === null ? null : document.getElementById(`turn-${here}`);
        const found: Range[] = [];
        const foundHere: Range[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          for (const match of (node.nodeValue ?? "").matchAll(pattern)) {
            const range = new Range();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            (within?.contains(node) ? foundHere : found).push(range);
          }
        }
        CSS.highlights.set("found", new Highlight(...found));
        CSS.highlights.set("found-here", new Highlight(...foundHere));
      };
      let frame = requestAnimationFrame(mark);
      const observer = new MutationObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(mark);
      });
      observer.observe(root, { subtree: true, childList: true, characterData: true });
      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        CSS.highlights.delete("found");
        CSS.highlights.delete("found-here");
      };
    };
  }
</script>

{#if conversation.turns.length === 0}
  <p class="text-muted">This session recorded nothing readable.</p>
{:else}
  <div class="grid grid-cols-[minmax(0,1fr)] gap-3" {@attach marks(highlight, revealed)}>
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
          {unfolded}
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

  <div class="h-px" {@attach onReach(() => conversation.more())}></div>

  {#if conversation.failure !== null}
    <Failure
      class="mt-4"
      error={conversation.failure}
      onretry={() => conversation.more()}
      retry="Retry loading more"
    />
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

<style>
  /* Drawn by the highlight registry over the text, so styled as a pseudo-element. */
  :global(::highlight(found)) {
    background-color: color-mix(in srgb, var(--warning) 22%, transparent);
  }

  :global(::highlight(found-here)) {
    background-color: color-mix(in srgb, var(--warning) 50%, transparent);
  }
</style>
