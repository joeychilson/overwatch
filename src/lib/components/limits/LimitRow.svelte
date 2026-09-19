<script lang="ts">
  /**
   * One limit of a subscription: its window, a bar of what is left, how much
   * that is, and when that changes. A window that has ended since it was read
   * has refilled, so its old figure is not shown as current.
   *
   * The parts name their grid areas, `name`, `bar`, `value` and `when`, so the
   * caller places them: all on one line, or the bar under the rest.
   */
  import type { Limit } from "#lib/api/backend.ts";
  import { band, ended, left, runsOut, type Band } from "#lib/limits.ts";
  import { now } from "#lib/state/clock.ts";
  import { formatCountdown, formatDateTime, formatPercent } from "#lib/format.ts";

  interface Props {
    limit: Limit;
    /** The row's areas, columns and spacing, which suit where it is shown. */
    class: string;
  }

  let { limit, class: className }: Props = $props();

  const TONE: Record<Band, string> = {
    blocked: "bg-danger",
    out: "bg-danger",
    low: "bg-warning",
    fine: "bg-muted",
  };

  const at = $derived(now().getTime());
  const level = $derived(band(limit, at));
  const refilled = $derived(ended(limit, at));
  const remaining = $derived(left(limit, at));
  const runs = $derived(runsOut(limit, at));
</script>

<li class="grid items-center {className}">
  <!-- The window first, so a long model name cannot hide which it is. -->
  <span
    class="truncate [grid-area:name]"
    title={limit.scope ? `${limit.name} · ${limit.scope}` : undefined}
  >
    {limit.name}{#if limit.scope}<span class="text-muted">{` · ${limit.scope}`}</span>{/if}
  </span>
  <!-- A wash of the text colour, so the track reads on any surface, translucent ones included. -->
  <span class="h-1.5 overflow-hidden rounded-full bg-text/10 [grid-area:bar]">
    <span class="block h-full rounded-full {TONE[level]}" style:width="{remaining}%"></span>
  </span>
  <span
    class="text-right font-medium tabular-nums [grid-area:value] {refilled || level === 'blocked'
      ? 'text-muted'
      : ''}"
  >
    {#if refilled}
      Full again
    {:else if level === "blocked"}
      Limit reached
    {:else}
      {formatPercent(remaining)} left
    {/if}
  </span>
  <span
    class="truncate text-meta [grid-area:when] {runs === null ? 'text-muted' : 'text-warning'}"
    title={limit.resetsAt === null || refilled
      ? undefined
      : `Resets ${formatDateTime(limit.resetsAt)}`}
  >
    {#if refilled || limit.resetsAt === null}
      <!-- Nothing further to say. -->
    {:else if level === "blocked"}
      Back in {formatCountdown(limit.resetsAt, at)}
    {:else if runs !== null}
      Runs out in {formatCountdown(runs, at)}
    {:else}
      Resets in {formatCountdown(limit.resetsAt, at)}
    {/if}
  </span>
</li>
