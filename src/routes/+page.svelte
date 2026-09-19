<script lang="ts">
  /**
   * What your agents have been doing: how much and on which days, with which
   * models, and in which projects and sessions.
   *
   * Each read is an `await` in markup that depends on the period and the index
   * revision, so choosing another period or finishing a scan re-reads, keeps the
   * last answer on screen meanwhile, and drops one that arrives late. Days are
   * bucketed by the engine in this machine's own zone, so a day here starts at
   * the reader's midnight, clock changes included. Today is drawn by the hour,
   * which the engine buckets the same way.
   *
   * The measure, tokens or cost, is the whole page's: the chart draws it and
   * every ranking orders by it. Only the top sessions are read for it, because
   * they are a different five by each; the other rankings reorder what they hold.
   */
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import Folder from "@lucide/svelte/icons/folder";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
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
  import { card, type Card } from "#lib/card.ts";
  import { errorLine } from "#lib/errors.ts";
  import { REPLACE, sortParam, withParams } from "#lib/address.ts";
  import {
    PERIODS,
    addDays,
    parsePeriod,
    periodParam,
    periodStart,
    startOfDay,
  } from "#lib/periods.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { getClock } from "#lib/state/clock.svelte.ts";
  import { ALL_TIME, NEWEST_FIRST } from "#lib/state/sessions.svelte.ts";
  import {
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
  const clock = getClock();

  const MEASURES: readonly { value: Measure; label: string }[] = [
    { value: "tokens", label: "Tokens" },
    { value: "cost", label: "Cost" },
  ];

  // The period and the measure live in the address, so coming back from what a
  // ranking opened finds the overview as it was left.
  const days = $derived(parsePeriod(page.url.searchParams.get("period")));
  const measure = $derived<Measure>(
    page.url.searchParams.get("measure") === "cost" ? "cost" : "tokens",
  );
  /** Largest first, which is how every ranking here orders and opens its list. */
  const largest = $derived({ key: measure, descending: true });

  /**
   * The period's totals and rankings, and the totals of as long just before it
   * to compare with.
   *
   * The revision is a parameter so that the read depends on it: when indexing
   * finds new work, Svelte re-runs this and nothing else has to know.
   */
  async function read(days: number | null, revision: number) {
    void revision;
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
  async function readSessions(days: number | null, measure: Measure, revision: number) {
    void revision;
    const since = periodStart(days);
    const top = await listSessions({
      since,
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

  /**
   * The days a period covers, such as `Aug 16 – Sep 14`, or for all of history
   * the day anything was first used, once that is known.
   */
  function covered(since: number | undefined, first?: number) {
    if (since !== undefined) return formatDays(since, startOfDay(clock.now.getTime()), clock.now);
    return first === undefined ? undefined : `Since ${formatDay(first, false, clock.now)}`;
  }

  /** The sessions of the period, ordered as the rankings are, narrowed further by `changes`. */
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

<!-- For all of history the header's line comes from the read, so every state of
     the read draws the header. -->
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
    <div class="grid justify-items-start gap-3">
      <p role="alert">Could not read your totals.</p>
      <code class="text-meta text-muted">{errorLine(error)}</code>
      <button class="h-9 rounded-control bg-active px-3" onclick={() => reset()}>Retry</button>
    </div>
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
    overview.sessions === 0 ? undefined : card({ overview, models, days, measure, now: clock.now }),
  )}

  {#if overview.sessions === 0}
    <p class="text-muted">
      {engine.status.scanning
        ? "Reading your agents' history…"
        : "No sessions used tokens in this period."}
    </p>
  {:else}
    <dl class="flex flex-wrap gap-x-12 gap-y-4">
      {#each [{ label: "Estimated cost", value: formatUsd(overview.costUsd), moved: change(overview.costUsd, before?.costUsd) }, { label: "Tokens", value: formatCountCompact(overview.tokens.total), moved: change(overview.tokens.total, before?.tokens.total) }, { label: "Sessions", value: formatCount(overview.sessions), moved: change(overview.sessions, before?.sessions) }] as stat (stat.label)}
        <div>
          <dt class="text-meta text-muted">{stat.label}</dt>
          <dd class="mt-1 flex items-baseline gap-2">
            <span class="text-title tabular-nums">{stat.value}</span>
            {#if stat.moved}
              <span
                class="text-meta text-muted tabular-nums"
                title={days === 1
                  ? "Compared with yesterday up to this time"
                  : `Compared with the ${days} days before`}
              >
                {stat.moved}
              </span>
            {/if}
          </dd>
        </div>
      {/each}
    </dl>

    <section class="mt-10">
      {@render heading("Usage")}
      <div class="mt-4">
        <UsageChart days={overview.daily} {hours} {since} {measure} />
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
  {/if}
</svelte:boundary>
