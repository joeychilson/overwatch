<script lang="ts">
  /**
   * What your agents have been doing: how much and on which days, with which
   * models, and in which projects and sessions.
   *
   * The measure, tokens or cost, is the whole page's: the chart draws it and
   * every ranking orders by it. Only the top sessions are read again for it,
   * since they are a different five by each; the other rankings reorder what
   * they hold.
   */
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import Folder from "@lucide/svelte/icons/folder";
  import Layers from "@lucide/svelte/icons/layers";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import Failure from "#lib/components/ui/Failure.svelte";
  import PageHeader, { pageIcon } from "#lib/components/ui/PageHeader.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import ShareButton from "#lib/components/share/ShareButton.svelte";
  import UsageChart from "#lib/components/charts/UsageChart.svelte";
  import Ranking, { SHOWN } from "#lib/components/charts/Ranking.svelte";
  import AgentMark from "#lib/components/marks/AgentMark.svelte";
  import { MOST_TOKENS } from "#lib/components/models/ModelRows.svelte";
  import {
    getOverview,
    listHours,
    listModels,
    listProjects,
    listSessions,
  } from "#lib/api/backend.ts";
  import { sessionLabel } from "#lib/agents.ts";
  import { REPLACE, withParams } from "#lib/address.ts";
  import { card, type Card } from "#lib/card.ts";
  import { sortParam } from "#lib/sort.ts";
  import {
    PERIODS,
    addDays,
    parsePeriod,
    periodParam,
    periodStart,
    startOfDay,
  } from "#lib/periods.ts";
  import { now } from "#lib/state/clock.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { ALL_TIME, NEWEST_FIRST } from "#lib/state/sessions.svelte.ts";
  import {
    UNKNOWN,
    formatCount,
    formatCountCompact,
    formatDay,
    formatDays,
    formatPercent,
    formatUsd,
    projectName,
    type Measure,
  } from "#lib/format.ts";

  const engine = getEngine();

  const READING = "Reading your agents' history…";

  const MEASURES: readonly { value: Measure; label: string }[] = [
    { value: "tokens", label: "Tokens" },
    { value: "cost", label: "Cost" },
  ];

  const days = $derived(parsePeriod(page.url.searchParams.get("period")));
  const measure = $derived<Measure>(
    page.url.searchParams.get("measure") === "cost" ? "cost" : "tokens",
  );
  /** Largest first, which is how every ranking here orders and opens its list. */
  const largest = $derived({ key: measure, descending: true });

  /** The period's totals and rankings, and the totals of as long just before it. */
  async function read(days: number | null, _revision: number) {
    const since = periodStart(days);
    const [overview, before, models, projects, hours] = await Promise.all([
      getOverview(since),
      since === undefined || days === null
        ? null
        : getOverview(addDays(since, -days), addDays(Date.now(), -days)),
      listModels(since),
      listProjects(since),
      days === 1 ? listHours(since) : undefined,
    ]);
    return { since, overview, before, models, projects, hours };
  }

  /** The period's sessions that used the most by a measure. */
  async function readSessions(days: number | null, measure: Measure, _revision: number) {
    const top = await listSessions({
      since: periodStart(days),
      sort: { key: measure, descending: true },
      limit: SHOWN,
    });
    return top.sessions;
  }

  /** How a figure moved against the period before, such as `↑ 12%`. */
  function change(current: number | null, previous: number | null | undefined) {
    if (current === null || !previous) return null;
    const percent = ((current - previous) / previous) * 100;
    if (Math.round(percent) === 0) return "±0%";
    return `${percent > 0 ? "↑" : "↓"} ${formatPercent(Math.abs(percent))}`;
  }

  /** The days a period covers, or for all of history the day anything was first used, once known. */
  function covered(since: number | undefined, first?: number) {
    const today = now();
    if (since !== undefined) return formatDays(since, startOfDay(today.getTime()), today);
    return first === undefined ? undefined : `Since ${formatDay(first, false, today)}`;
  }

  /** The period's sessions, ordered as the rankings are, narrowed further by `changes`. */
  function sessionsHref(changes: Record<string, string> = {}) {
    return withParams(
      { pathname: resolve("/sessions"), search: "" },
      {
        period: periodParam(days, ALL_TIME),
        sort: sortParam(largest, NEWEST_FIRST),
        ...changes,
      },
    );
  }
</script>

<svelte:head><title>Overview · Overwatch</title></svelte:head>

{#snippet header(description?: string, picture?: Card)}
  <PageHeader title="Overview" {description}>
    {#snippet icon()}<LayoutGrid {...pageIcon} />{/snippet}
    {#snippet actions()}
      <ShareButton card={picture} />
      <Segmented
        options={MEASURES}
        value={measure}
        onchange={(next) =>
          void goto(withParams(page.url, { measure: next === "cost" ? next : null }), REPLACE)}
      />
      <Segmented
        options={PERIODS}
        value={days}
        onchange={(next) => void goto(withParams(page.url, { period: periodParam(next) }), REPLACE)}
      />
    {/snippet}
  </PageHeader>
{/snippet}

{#snippet heading(title: string, link?: { href: string; label: string })}
  <div class="flex items-baseline justify-between gap-3">
    <h2 class="text-section">{title}</h2>
    {#if link}
      <a class="text-meta text-muted hover:text-text" href={link.href}>{link.label}</a>
    {/if}
  </div>
{/snippet}

{#snippet stat(label: string, value: string, moved: string | null)}
  <div>
    <dt class="text-meta text-muted">{label}</dt>
    <dd class="mt-1 flex items-baseline gap-2">
      <span class="text-title tabular-nums">{value}</span>
      {#if moved}
        <span
          class="text-meta text-muted tabular-nums"
          title={days === 1
            ? "Compared with yesterday up to this time"
            : `Compared with the ${days} days before`}
        >
          {moved}
        </span>
      {/if}
    </dd>
  </div>
{/snippet}

<!-- For all of history the header's line comes from the read, so every state draws the header. -->
<svelte:boundary>
  {#snippet pending()}
    {@render header(covered(periodStart(days)))}
    <div aria-hidden="true">
      <div class="h-14 w-96 max-w-full animate-pulse rounded-menu bg-hover"></div>
      <div class="mt-10 h-72 animate-pulse rounded-menu bg-hover"></div>
    </div>
  {/snippet}

  {#snippet failed(error, reset)}
    {@render header(covered(periodStart(days)))}
    <Failure title="Could not read your totals." {error} onretry={reset} />
  {/snippet}

  <!-- Awaited together so that both start at once; another measure reads only the sessions. -->
  {@const period = read(days, engine.revision)}
  {@const top = readSessions(days, measure, engine.revision)}
  {@const [{ since, overview, before, models, projects, hours }, sessions] = await Promise.all([
    period,
    top,
  ])}

  {@render header(
    covered(since, overview.daily[0]?.day),
    overview.sessions === 0 ? undefined : card({ overview, models, days, measure, now: now() }),
  )}

  <!-- While the first index is read, what the period used is not known yet, which is not zero. -->
  {@const reading = engine.status.scanning && overview.sessions === 0}
  <!-- Nothing used costs nothing; usage with no listed price is still unknown. -->
  {@const cost = overview.tokens.total === 0 ? 0 : overview.costUsd}

  <dl class="flex flex-wrap gap-x-12 gap-y-4">
    {#if reading}
      {@render stat("Estimated cost", UNKNOWN, null)}
      {@render stat("Tokens", UNKNOWN, null)}
      {@render stat("Sessions", UNKNOWN, null)}
    {:else}
      {@render stat("Estimated cost", formatUsd(cost), change(cost, before?.costUsd))}
      {@render stat(
        "Tokens",
        formatCountCompact(overview.tokens.total),
        change(overview.tokens.total, before?.tokens.total),
      )}
      {@render stat(
        "Sessions",
        formatCount(overview.sessions),
        change(overview.sessions, before?.sessions),
      )}
    {/if}
  </dl>

  <section class="mt-10">
    {@render heading("Usage")}
    <div class="mt-4">
      <UsageChart
        days={overview.daily}
        {hours}
        {since}
        {measure}
        empty={reading
          ? READING
          : days === 1
            ? "Nothing has used tokens yet today"
            : "Nothing used tokens in this period"}
      />
    </div>
  </section>

  <!-- Tracks that cannot grow past the page, so a long title truncates. -->
  <div class="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-2">
    <section>
      {@render heading("Top models", {
        href: withParams(
          { pathname: resolve("/models"), search: "" },
          { period: periodParam(days), sort: sortParam(largest, MOST_TOKENS) },
        ),
        label: "All models",
      })}
      <div class="mt-2">
        <Ranking
          label="Top models"
          items={models}
          {measure}
          empty={{
            icon: Layers,
            title: reading ? READING : "No model used tokens in this period",
          }}
          href={(model) => sessionsHref({ model: model.model })}
        >
          {#snippet row(model)}
            <span class="flex shrink-0 items-center gap-1">
              {#each model.agents as agent (agent)}
                <AgentMark {agent} size={14} class="text-muted" />
              {/each}
            </span>
            <span class="truncate font-mono text-meta" title={model.model}>{model.model}</span>
          {/snippet}
        </Ranking>
      </div>
    </section>

    <section>
      {@render heading("Top projects")}
      <div class="mt-2">
        <Ranking
          label="Top projects"
          items={projects}
          {measure}
          empty={{
            icon: Folder,
            title: reading ? READING : "No project used tokens in this period",
          }}
          href={(project) => sessionsHref({ project: project.project })}
        >
          {#snippet row(project)}
            <Folder class="shrink-0 text-muted" size={14} aria-hidden="true" />
            <span class="truncate" title={project.project}>{projectName(project.project)}</span>
          {/snippet}
        </Ranking>
      </div>
    </section>

    <section class="lg:col-span-2">
      {@render heading("Top sessions", { href: sessionsHref(), label: "All sessions" })}
      <div class="mt-2">
        <Ranking
          label="Top sessions"
          items={sessions}
          {measure}
          empty={{
            icon: SquareTerminal,
            // The spawned runs a period's sessions count are not ranked here.
            title: reading ? READING : "No conversation used tokens in this period",
          }}
          href={(session) => resolve("/sessions/[id]", { id: session.id })}
        >
          {#snippet row(session)}
            <AgentMark agent={session.agent} size={14} class="shrink-0 text-muted" />
            <span class="truncate" title={session.title ?? undefined}>
              {sessionLabel(session)}
            </span>
            {#if session.cwd !== null}
              <span class="ml-auto hidden shrink-0 text-meta text-muted sm:block">
                {projectName(session.cwd)}
              </span>
            {/if}
          {/snippet}
        </Ranking>
      </div>
    </section>
  </div>
</svelte:boundary>
