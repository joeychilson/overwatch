<script module lang="ts">
  /** How many items a ranking shows. */
  export const SHOWN = 5;
</script>

<script lang="ts" generics="T extends { tokens: Tokens; costUsd: number | null }">
  /**
   * The few items that used the most, one line each: what it is, a bar against
   * the largest, and how much.
   *
   * Items rank by the measure shown. By cost, one with no price ranks below
   * every priced one, since unknown is not zero.
   */
  import type { Snippet } from "svelte";
  import type { Tokens } from "#lib/api/backend.ts";
  import { formatMeasure, type Measure } from "#lib/format.ts";
  import { sorted } from "#lib/sort.ts";

  interface Props {
    items: readonly T[];
    measure: Measure;
    /** What the items are, for assistive technology. */
    label: string;
    href: (item: T) => string;
    /** What one item is, ahead of its bar. */
    row: Snippet<[T]>;
  }

  let { items, measure, label, href, row }: Props = $props();

  function amount(item: T): number | null {
    return measure === "cost" ? item.costUsd : item.tokens.total;
  }

  const ranked = $derived(sorted(items, amount, true).slice(0, SHOWN));
  const largest = $derived(Math.max(0, ...ranked.map((item) => amount(item) ?? 0)));
</script>

<ul aria-label={label}>
  {#each ranked as item, index (index)}
    {@const value = amount(item)}
    <li>
      <a
        class="flex items-center gap-3 rounded-control px-2.5 py-2 hover:bg-hover"
        href={href(item)}
      >
        <span class="flex min-w-0 flex-1 items-center gap-2">{@render row(item)}</span>
        <span class="hidden h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-hover sm:block">
          <span
            class="block h-full rounded-full bg-muted"
            style:width="{largest > 0 ? ((value ?? 0) / largest) * 100 : 0}%"
          ></span>
        </span>
        <span class="w-20 shrink-0 text-right tabular-nums {value === null ? 'text-muted' : ''}">
          {formatMeasure(value, measure)}
        </span>
      </a>
    </li>
  {:else}
    <li class="px-2.5 py-2 text-muted">None in this period.</li>
  {/each}
</ul>
