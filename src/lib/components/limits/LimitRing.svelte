<script lang="ts">
  /**
   * A subscription's mark in a ring drawn as far round as its tightest limit
   * has left, from twelve o'clock, as the menu bar item draws the app's mark.
   * The ring takes the colour a limit's bar would, or fades when the figure is
   * the last one read rather than a current one. It is decorative: the figure
   * is always written beside it or under it.
   */
  import Mark from "#lib/components/marks/Mark.svelte";
  import type { MarkName } from "#lib/components/marks/marks.ts";
  import type { Band } from "#lib/limits.ts";

  interface Props {
    mark: MarkName;
    /** How much is left, from 0 to 100, or null for a subscription with no limit on all usage. */
    left: number | null;
    band: Band;
    /** Whether the figure is the last one read, which may no longer hold. */
    stale?: boolean;
    /** Edge length in pixels; the mark inside is half of it. */
    size?: number;
  }

  let { mark, left, band, stale = false, size = 26 }: Props = $props();

  const TONE: Record<Band, string> = {
    blocked: "text-danger",
    out: "text-danger",
    low: "text-warning",
    fine: "text-muted",
  };
</script>

<span
  class="relative grid shrink-0 place-items-center"
  style:width="{size}px"
  style:height="{size}px"
  aria-hidden="true"
>
  <svg class="absolute inset-0 -rotate-90" viewBox="0 0 26 26">
    <!-- A wash of the text colour, as a bar's track is. -->
    <circle cx="13" cy="13" r="12" fill="none" stroke-width="2" class="stroke-text/12" />
    {#if left !== null && left > 0}
      <circle
        class={stale ? "text-text/30" : TONE[band]}
        cx="13"
        cy="13"
        r="12"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        pathLength="100"
        stroke-dasharray="{left} 100"
      />
    {/if}
  </svg>
  <Mark name={mark} size={Math.round(size / 2)} />
</span>
