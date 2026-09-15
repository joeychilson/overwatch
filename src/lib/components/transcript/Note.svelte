<script lang="ts">
  /**
   * Something the harness added to the conversation, as one line.
   *
   * Environment details, instructions, reminders and command output are how
   * the agent was set up rather than what anyone said, so each reads as its
   * name, and opens to show exactly what was added when there is more to it.
   */
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Info from "@lucide/svelte/icons/info";
  import type { Turn } from "#lib/api/backend.ts";
  import { noteTitle } from "#lib/transcript.ts";

  interface Props {
    turn: Turn;
    /** Whether the timeline last brought it into view. */
    revealed: boolean;
  }

  let { turn, revealed }: Props = $props();

  let open = $state(false);

  const title = $derived(noteTitle(turn.text));
  const text = $derived(turn.text.trim());
  /** Whether opening it shows more than its title already says. */
  const more = $derived(text.includes("\n") || text.length > title.length + 2);
</script>

<div
  id="turn-{turn.index}"
  class="min-w-0 scroll-mt-24 rounded-control {revealed ? 'bg-hover' : ''}"
>
  {#if more}
    <button
      class="flex max-w-full min-w-0 items-center gap-2 rounded-control px-2 py-1 text-left text-meta text-muted hover:text-text"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      <Info class="shrink-0" size={13} aria-hidden="true" />
      <span class="truncate">{title}</span>
      <ChevronRight
        class="shrink-0 transition-transform {open ? 'rotate-90' : ''}"
        size={13}
        aria-hidden="true"
      />
    </button>
    {#if open}
      <pre
        class="mx-2 mt-1 mb-2 max-h-80 overflow-auto rounded-item bg-hover p-2 font-mono text-meta wrap-anywhere whitespace-pre-wrap">{text}</pre>
    {/if}
  {:else}
    <p class="flex min-w-0 items-center gap-2 px-2 py-1 text-meta text-muted">
      <Info class="shrink-0" size={13} aria-hidden="true" />
      <span class="truncate">{title}</span>
    </p>
  {/if}
</div>
