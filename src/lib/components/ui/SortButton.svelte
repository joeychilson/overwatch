<script lang="ts">
  /** A column's heading that orders the rows by it, and shows which way they run. */
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";

  interface Props {
    label: string;
    /** Whether the rows are ordered by this column. */
    active: boolean;
    descending: boolean;
    onclick: () => void;
    class?: string;
  }

  let { label, active, descending, onclick, class: className = "" }: Props = $props();
</script>

<button
  class="flex items-center gap-1 hover:text-text {className}"
  {onclick}
  aria-label="Sort by {label}"
>
  <span class="truncate">{label}</span>
  {#if !active}
    <ChevronsUpDown class="shrink-0 opacity-40" size={12} aria-hidden="true" />
  {:else if descending}
    <ArrowDown class="shrink-0" size={12} aria-hidden="true" />
  {:else}
    <ArrowUp class="shrink-0" size={12} aria-hidden="true" />
  {/if}
</button>
