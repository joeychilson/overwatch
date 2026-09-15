<script lang="ts">
  /**
   * The models your own sessions used.
   *
   * The period and the ordering live in the address, so opening a model's
   * sessions and coming back finds the ranking as it was left. The ranking is
   * an `await` inside the boundary below: changing the period changes what is
   * awaited, so Svelte re-reads, keeps the previous ranking on screen while it
   * does, discards a result that arrives after a newer one, and routes a
   * failure to the boundary. Ordering happens here, on rows already read.
   *
   * Cost is estimated at list prices. A model with no listed price shows no
   * cost rather than $0.00, which would say its usage was free.
   */
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import Layers from "@lucide/svelte/icons/layers";
  import PageHeader, { pageIcon } from "#lib/components/ui/PageHeader.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import ModelRows, {
    MODEL_KEYS,
    MOST_TOKENS,
    type ModelKey,
  } from "#lib/components/models/ModelRows.svelte";
  import { listModels } from "#lib/api/backend.ts";
  import { REPLACE, parseSort, sortParam, withParams } from "#lib/address.ts";
  import { errorLine } from "#lib/errors.ts";
  import { PERIODS, parsePeriod, periodParam, periodStart } from "#lib/periods.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { ALL_TIME } from "#lib/state/sessions.svelte.ts";
  import { formatCountCompact, formatUsd } from "#lib/format.ts";

  const engine = getEngine();

  /** Names read A to Z; every measure reads largest first. */
  const DESCENDING_FIRST: ReadonlySet<ModelKey> = new Set(["sessions", "tokens", "cost"]);

  const days = $derived(parsePeriod(page.url.searchParams.get("period")));
  const sort = $derived(parseSort(page.url.searchParams.get("sort"), MODEL_KEYS, MOST_TOKENS));

  /**
   * Read the ranking for a period, as of a given index revision.
   *
   * The revision is a parameter so that the read depends on it: when indexing
   * finds new work, Svelte re-runs this and nothing else has to know.
   */
  async function read(days: number | null, revision: number) {
    void revision;
    const since = periodStart(days);
    return { since, models: await listModels(since) };
  }

  function toggleSort(key: ModelKey) {
    const next =
      sort.key === key
        ? { key, descending: !sort.descending }
        : { key, descending: DESCENDING_FIRST.has(key) };
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

<!-- The header's line comes from the read, so every state of the read draws the header. -->
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
    <div class="grid justify-items-start gap-3">
      <p role="alert">Could not read model usage.</p>
      <code class="text-meta text-muted">{errorLine(error)}</code>
      <button class="h-9 rounded-control bg-active px-3" onclick={() => reset()}>Retry</button>
    </div>
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
          `${models.length} models`,
          `${formatCountCompact(tokens)} tokens`,
          cost === null ? null : `${formatUsd(cost)} estimated`,
        ]
          .filter(Boolean)
          .join(" · "),
  )}

  {#if models.length === 0}
    <p class="text-muted">No usage was recorded in this period.</p>
  {:else}
    <div aria-busy={$effect.pending() > 0}>
      <ModelRows {models} {tokens} {since} {sort} onsort={toggleSort} {sessionsHref} />
    </div>
  {/if}
</svelte:boundary>
