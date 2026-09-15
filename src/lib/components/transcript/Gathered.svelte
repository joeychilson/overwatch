<script lang="ts">
  /**
   * A run of turns of one kind between two things said, gathered under one
   * line: the steps towards a reply, or what the harness added.
   *
   * The line names what the run holds — the tools used most, or what the
   * harness calls each addition — how long its steps took, and whether any
   * failed, which is what someone deciding whether to look needs. A run of one
   * needs no gathering and shows as itself.
   */
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import type { Turn } from "#lib/api/backend.ts";
  import { formatDuration } from "#lib/format.ts";
  import { noteTitle, stepsSummary } from "#lib/transcript.ts";
  import Note from "./Note.svelte";
  import Step from "./Step.svelte";

  interface Props {
    turns: readonly Turn[];
    open: boolean;
    ontoggle: () => void;
    /** The turn the timeline last brought into view, if any. */
    revealed: number | null;
  }

  let { turns, open, ontoggle, revealed }: Props = $props();

  const notes = $derived(turns[0]?.speaker === "system");
  const Item = $derived(notes ? Note : Step);
  const summary = $derived(
    notes ? turns.map((turn) => noteTitle(turn.text)).join(" · ") : stepsSummary(turns),
  );
  const failed = $derived(turns.filter((turn) => turn.tool?.failed).length);
  const took = $derived.by(() => {
    const times = turns.flatMap((turn) => (turn.at === null ? [] : [turn.at]));
    const seconds = ((times.at(-1) ?? 0) - (times[0] ?? 0)) / 1000;
    return !notes && seconds >= 1 ? formatDuration(seconds) : null;
  });
</script>

{#if turns.length === 1 && turns[0]}
  <Item turn={turns[0]} revealed={revealed === turns[0].index} />
{:else}
  <div class="min-w-0">
    <button
      class="flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1 text-left text-meta text-muted hover:bg-hover hover:text-text"
      aria-expanded={open}
      onclick={ontoggle}
    >
      <ChevronRight
        class="shrink-0 transition-transform {open ? 'rotate-90' : ''}"
        size={14}
        aria-hidden="true"
      />
      <span class="min-w-0 truncate">{summary}</span>
      {#if failed > 0}
        <span class="shrink-0 text-danger">{failed} failed</span>
      {/if}
      {#if took}
        <span class="ml-auto shrink-0 tabular-nums">{took}</span>
      {/if}
    </button>

    {#if open}
      <div class="mt-0.5 ml-[15px] grid min-w-0 border-l border-border pl-2">
        {#each turns as turn (turn.index)}
          <Item {turn} revealed={revealed === turn.index} />
        {/each}
      </div>
    {/if}
  </div>
{/if}
