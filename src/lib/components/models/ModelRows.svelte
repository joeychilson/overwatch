<script module lang="ts">
  import type { Ordering } from "#lib/address.ts";

  /** The columns models can be ordered by. */
  export const MODEL_KEYS = ["model", "sessions", "tokens", "cost"] as const;
  export type ModelKey = (typeof MODEL_KEYS)[number];
  /** The ordering the page opens with: the most tokens first. */
  export const MOST_TOKENS: Ordering<ModelKey> = { key: "tokens", descending: true };
</script>

<script lang="ts">
  /**
   * Models ranked by the work that went through them.
   *
   * Each row opens the sessions that used its model. The trend draws the
   * period a day or a week to a bar, so a model coming into use or falling out
   * of it shows without a chart of its own, and the share is of all the
   * period's tokens.
   */
  import type { ModelUsage } from "#lib/api/backend.ts";
  import AgentMark from "#lib/components/marks/AgentMark.svelte";
  import Sparkline from "#lib/components/charts/Sparkline.svelte";
  import SortButton from "#lib/components/ui/SortButton.svelte";
  import { columns } from "#lib/components/charts/columns.ts";
  import {
    UNKNOWN,
    formatCount,
    formatCountCompact,
    formatPercent,
    formatUsd,
  } from "#lib/format.ts";

  interface Props {
    models: readonly ModelUsage[];
    /** Tokens across every model in the period, for each model's share. */
    tokens: number;
    /** When the period began; unset for all of history. */
    since: number | undefined;
    sort: Ordering<ModelKey>;
    onsort: (key: ModelKey) => void;
    /** Where the sessions that used a model are. */
    sessionsHref: (model: string) => string;
  }

  let { models, tokens, since, sort, onsort, sessionsHref }: Props = $props();

  const ranked = $derived.by(() => {
    const direction = sort.descending ? -1 : 1;
    const measure = (model: ModelUsage) =>
      sort.key === "sessions"
        ? model.sessions
        : sort.key === "tokens"
          ? model.tokens.total
          : // A model with no price sorts as cheaper than every priced one.
            (model.costUsd ?? -1);
    return [...models].sort(
      (a, b) =>
        direction *
        (sort.key === "model" ? a.model.localeCompare(b.model) : measure(a) - measure(b)),
    );
  });

  /** The period's columns, from its start or, for all of history, the first day of use. */
  const laid = $derived(
    columns(
      since ??
        Math.min(Date.now(), ...models.flatMap((model) => model.daily.map((day) => day.day))),
    ),
  );

  function trend(model: ModelUsage): number[] {
    const values = laid.starts.map(() => 0);
    for (const day of model.daily) {
      const at = laid.of(day.day);
      if (at !== undefined) values[at] = (values[at] ?? 0) + day.tokens;
    }
    return values;
  }
</script>

<div class="flex items-center gap-3 px-2.5 pb-1 text-meta text-muted">
  <SortButton
    class="min-w-0 flex-1"
    label="Model"
    active={sort.key === "model"}
    descending={sort.descending}
    onclick={() => onsort("model")}
  />
  <span class="hidden w-24 shrink-0 lg:block">Trend</span>
  <span class="hidden w-12 shrink-0 text-right sm:block">Share</span>
  <SortButton
    class="w-20 shrink-0 justify-end"
    label="Sessions"
    active={sort.key === "sessions"}
    descending={sort.descending}
    onclick={() => onsort("sessions")}
  />
  <SortButton
    class="w-20 shrink-0 justify-end"
    label="Tokens"
    active={sort.key === "tokens"}
    descending={sort.descending}
    onclick={() => onsort("tokens")}
  />
  <SortButton
    class="w-24 shrink-0 justify-end"
    label="Cost"
    active={sort.key === "cost"}
    descending={sort.descending}
    onclick={() => onsort("cost")}
  />
</div>

<ul aria-label="Models">
  {#each ranked as model (model.model)}
    {@const share = tokens === 0 ? 0 : (model.tokens.total / tokens) * 100}
    {@const values = trend(model)}
    <li>
      <a
        class="flex items-center gap-3 rounded-control px-2.5 py-2 hover:bg-hover"
        href={sessionsHref(model.model)}
      >
        <span class="flex min-w-0 flex-1 items-center gap-2">
          <span class="flex shrink-0 items-center gap-1">
            {#each model.agents as agent (agent)}
              <AgentMark {agent} size={14} class="shrink-0 text-muted" />
            {/each}
          </span>
          <span class="truncate font-mono text-meta" title={model.model}>{model.model}</span>
        </span>

        <span class="hidden w-24 shrink-0 lg:block">
          <Sparkline
            {values}
            label="Used in {values.filter((value) => value > 0)
              .length} of {values.length} {laid.weekly ? 'weeks' : 'days'}"
          />
        </span>
        <span class="hidden w-12 shrink-0 text-right text-meta text-muted tabular-nums sm:block">
          <!-- A model that was used is never shown as none of the total. -->
          {share > 0 && share < 0.5 ? "<1%" : formatPercent(share)}
        </span>
        <span class="w-20 shrink-0 text-right text-muted tabular-nums">
          {formatCount(model.sessions)}
        </span>
        <span
          class="w-20 shrink-0 text-right tabular-nums"
          title="{formatCount(model.tokens.total)} tokens"
        >
          {model.tokens.total === 0 ? UNKNOWN : formatCountCompact(model.tokens.total)}
        </span>
        <span
          class="w-24 shrink-0 text-right tabular-nums {model.costUsd === null ? 'text-muted' : ''}"
          title={model.costUsd === null ? "No price is listed for this model" : ""}
        >
          {formatUsd(model.costUsd)}
        </span>
      </a>
    </li>
  {/each}
</ul>
