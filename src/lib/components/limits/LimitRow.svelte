<script lang="ts">
  /**
   * One limit of a subscription: its window, a bar of what is left, how much
   * that is, and when that changes. A window that has ended since it was read
   * has refilled, so its old figure is not shown as current. A tick on the bar
   * marks how much of the window's time is left: while the bar reaches past
   * it, the limit is going more slowly than the window, and will outlast it.
   *
   * The parts name their grid areas, `name`, `bar`, `value` and `when`, so the
   * caller places them: all on one line, or the bar under the rest.
   */
  import type { Limit } from "#lib/api/backend.ts";
  import { band, ended, left, onTrackFor, runsOut, timeLeft, type Band } from "#lib/limits.ts";
  import { now } from "#lib/state/clock.ts";
  import { formatCountdown, formatDateTime, formatPercent } from "#lib/format.ts";

  interface Props {
    limit: Limit;
    /** When the limit was read, which its use is as of; now when not given. */
    readAt?: number | null;
    /** The row's areas, columns and spacing, which suit where it is shown. */
    class: string;
  }

  let { limit, readAt = null, class: className }: Props = $props();

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
  /** How much of the window is left, for the tick, unless there is nothing left to pace. */
  const time = $derived(level === "blocked" ? null : timeLeft(limit, at));
  /**
   * The tick in words, for the tooltip and for assistive technology. Use is as
   * of the reading, so it is set beside the window as it stood then. While the
   * recent pace says it runs out, the window's average is not said beside it.
   */
  const pace = $derived.by(() => {
    if (time === null) return null;
    const then = readAt ?? at;
    const leftThen = timeLeft(limit, then);
    if (leftThen === null) return null;
    const so = `${formatPercent(limit.usedPercent)} used with ${formatPercent(100 - leftThen)} of the window gone`;
    const heading = runs === null ? onTrackFor(limit, then) : null;
    if (heading === null) return `${so}.`;
    return heading >= 100
      ? `${so}: at that rate it runs out before the reset.`
      : `${so}: at that rate, about ${formatPercent(heading)} by the reset.`;
  });
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
  <span class="relative h-1.5 [grid-area:bar]" title={pace ?? undefined}>
    <span class="absolute inset-0 overflow-hidden rounded-full bg-text/10">
      <span class="block h-full rounded-full {TONE[level]}" style:width="{remaining}%"></span>
    </span>
    {#if time !== null}
      <!-- Taller than the bar, in the text colour, so it reads on the fill and the track alike. -->
      <span
        class="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text"
        style:left="{time}%"
      ></span>
    {/if}
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
      : [`Resets ${formatDateTime(limit.resetsAt)}.`, pace].filter(Boolean).join(" ")}
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
    {#if pace !== null}<span class="sr-only"> {pace}</span>{/if}
  </span>
</li>
