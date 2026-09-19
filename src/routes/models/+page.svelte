<script lang="ts">
  /**
   * The models your sessions used. The period and the ordering live in the
   * address, so opening a model's sessions and coming back finds the ranking
   * as it was left. Ordering happens here, on the rows already read.
   */
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import Layers from "@lucide/svelte/icons/layers";
  import Failure from "#lib/components/ui/Failure.svelte";
  import PageHeader, { pageIcon } from "#lib/components/ui/PageHeader.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import ModelRows, {
    MODEL_KEYS,
    MOST_TOKENS,
    type ModelKey,
  } from "#lib/components/models/ModelRows.svelte";
  import { listModels } from "#lib/api/backend.ts";
  import { REPLACE, withParams } from "#lib/address.ts";
  import { PERIODS, parsePeriod, periodParam, periodStart } from "#lib/periods.ts";
  import { parseSort, sortParam, toggled } from "#lib/sort.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { ALL_TIME } from "#lib/state/sessions.svelte.ts";
  import { formatCount, formatCountCompact, formatUsd } from "#lib/format.ts";

  const engine = getEngine();

  /** Names read A to Z; every measure reads largest first. */
  const DESCENDING_FIRST: ReadonlySet<ModelKey> = new Set(["sessions", "tokens", "cost"]);

  const days = $derived(parsePeriod(page.url.searchParams.get("period")));
  const sort = $derived(parseSort(page.url.searchParams.get("sort"), MODEL_KEYS, MOST_TOKENS));

  async function read(days: number | null, _revision: number) {
    const since = periodStart(days);
    return { since, models: await listModels(since) };
  }

  function toggleSort(key: ModelKey) {
    const next = toggled(sort, key, DESCENDING_FIRST);
    void goto(withParams(page.url, { sort: sortParam(next, MOST_TOKENS) }), REPLACE);
  }

  /** The sessions that used a model in the period shown. */
  function sessionsHref(model: string) {
    return withParams(
      { pathname: resolve("/sessions"), search: "" },
      { period: periodParam(days, ALL_TIME), model },
    );
  }
</script>

<svelte:head><title>Models · Overwatch</title></svelte:head>

{#snippet header(description?: string)}
  <PageHeader title="Models" {description}>
    {#snippet icon()}<Layers {...pageIcon} />{/snippet}
    {#snippet actions()}
      <Segmented
        options={PERIODS}
        value={days}
        onchange={(next) => void goto(withParams(page.url, { period: periodParam(next) }), REPLACE)}
      />
    {/snippet}
  </PageHeader>
{/snippet}

<!-- The header's line comes from the read, so every state draws the header. -->
<svelte:boundary>
  {#snippet pending()}
    {@render header("Reading model usage…")}
    <div class="grid gap-2" aria-hidden="true">
      {#each Array.from({ length: 6 }, (_, index) => index) as row (row)}
        <div class="h-11 animate-pulse rounded-control bg-hover"></div>
      {/each}
    </div>
  {/snippet}

  {#snippet failed(error, reset)}
    {@render header()}
    <Failure title="Could not read model usage." {error} onretry={reset} />
  {/snippet}

  {@const { since, models } = await read(days, engine.revision)}
  {@const tokens = models.reduce((sum, model) => sum + model.tokens.total, 0)}
  {@const cost = models.reduce<number | null>(
    (sum, model) => (model.costUsd === null ? sum : (sum ?? 0) + model.costUsd),
    null,
  )}

  {@render header(
    models.length === 0
      ? undefined
      : [
          `${formatCount(models.length)} ${models.length === 1 ? "model" : "models"}`,
          `${formatCountCompact(tokens)} tokens`,
          cost === null ? null : `${formatUsd(cost)} estimated`,
        ]
          .filter(Boolean)
          .join(" · "),
  )}

  <div aria-busy={$effect.pending() > 0}>
    <ModelRows {models} {tokens} {since} {sort} onsort={toggleSort} {sessionsHref} />
  </div>
</svelte:boundary>
