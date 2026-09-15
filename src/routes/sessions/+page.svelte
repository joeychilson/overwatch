<script module lang="ts">
  import { SessionList } from "#lib/state/sessions.svelte.ts";

  /**
   * The rows, kept between visits: coming back from a session shows them at
   * once and where they were, instead of reading and scrolling all over again.
   */
  const list = new SessionList();
  /** The filter the rows were last read for, so a visit that changes nothing reads nothing. */
  let applied: string | undefined;
</script>

<script lang="ts">
  /**
   * Every session, newest first.
   *
   * What the list shows — its search, its ordering, and what it is narrowed
   * to — lives in the address, so opening a session and going back returns to
   * the same list, and the app's menu can open it searching. It re-reads
   * whenever the address or the index changes, which is affordable because a
   * filtered, sorted, counted page comes back in well under a millisecond.
   */
  import { onDestroy } from "svelte";
  import { afterNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import Calendar from "@lucide/svelte/icons/calendar";
  import Folder from "@lucide/svelte/icons/folder";
  import Layers from "@lucide/svelte/icons/layers";
  import Search from "@lucide/svelte/icons/search";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import X from "@lucide/svelte/icons/x";
  import type { Filter, SortKey } from "#lib/api/backend.ts";
  import PageHeader, { pageIcon } from "#lib/components/ui/PageHeader.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import AgentMark from "#lib/components/marks/AgentMark.svelte";
  import SessionRows from "#lib/components/sessions/SessionRows.svelte";
  import { agentName, parseAgent } from "#lib/agents.ts";
  import { REPLACE, parseSort, sortParam, withParams } from "#lib/address.ts";
  import {
    PERIODS,
    addDays,
    parseDayKey,
    parsePeriod,
    periodParam,
    periodStart,
  } from "#lib/periods.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { getClock } from "#lib/state/clock.svelte.ts";
  import { ALL_TIME, NEWEST_FIRST } from "#lib/state/sessions.svelte.ts";
  import {
    formatCount,
    formatCountCompact,
    formatDays,
    formatUsd,
    projectName,
  } from "#lib/format.ts";

  const engine = getEngine();
  const clock = getClock();

  const SORT_KEYS: readonly SortKey[] = ["updated", "started", "tokens", "cost", "title"];
  /** Recency and size read newest and largest first; a title reads A to Z. */
  const DESCENDING_FIRST: ReadonlySet<SortKey> = new Set(["updated", "started", "tokens", "cost"]);

  /** How long typing settles before it is sent. */
  const SETTLE_MS = 150;

  /** Every chip narrowing the list shares one look. */
  const CHIP =
    "flex h-9 min-w-0 shrink-0 items-center gap-2 rounded-control border border-border pr-2 pl-2.5 hover:bg-hover";

  const params = $derived(page.url.searchParams);
  /**
   * The agent the list is narrowed to. A key naming no agent is dropped rather
   * than sent, because the engine would reject the whole read over it.
   */
  const agent = $derived(parseAgent(params.get("agent")));
  /** The period, as the overview and the Models page name theirs. */
  const period = $derived(parsePeriod(params.get("period"), ALL_TIME));
  /**
   * The days of a column of the overview's chart, from its first through its
   * last. They are narrower than any period, so they take its place.
   */
  const days = $derived.by(() => {
    const from = parseDayKey(params.get("from"));
    const to = parseDayKey(params.get("to"));
    return from === null || to === null
      ? null
      : { from, to, label: formatDays(from, to, clock.now) };
  });
  /** The project, from a row, matched whole. */
  const project = $derived(params.get("project"));
  /** The model, from a row or the Models page, matched whole. */
  const model = $derived(params.get("model"));
  /**
   * Whether spawned runs are included.
   *
   * Agents spawn far more sessions than people start: subagents, automated
   * reviews and forked threads outnumber real conversations here. They are
   * real, but someone looking for a conversation they had does not want to wade
   * through them, so the list opens on top-level work and says so.
   */
  const spawned = $derived(params.get("runs") === "all");
  const sort = $derived(parseSort(params.get("sort"), SORT_KEYS, NEWEST_FIRST));

  /** What is in the search box; it reaches the address once typing settles. */
  let search = $state("");

  let settling: ReturnType<typeof setTimeout> | undefined;

  /** Read what the address describes, unless the rows already are that. */
  function load() {
    const filter: Filter = {
      search: params.get("q")?.trim() || null,
      agents: agent === null ? [] : [agent],
      // A column's days run from the first's midnight to the instant before
      // the one after the last, however long the days; a period has no end.
      since: days?.from ?? periodStart(period) ?? null,
      until: days === null ? null : addDays(days.to, 1) - 1,
      project,
      model,
      sort,
      includeSpawned: spawned,
    };
    const key = JSON.stringify(filter);
    if (key === applied) return;
    applied = key;
    void list.apply(filter);
  }

  /** Show the list with some of what the address says changed, in place. */
  function change(changes: Record<string, string | null>) {
    void goto(withParams(page.url, changes), REPLACE);
  }

  /** Let typing settle, so a fast typist issues one read rather than five. */
  function scheduleSearch() {
    clearTimeout(settling);
    settling = setTimeout(() => change({ q: search.trim() || null }), SETTLE_MS);
  }

  function toggleSort(key: SortKey) {
    const next =
      sort.key === key
        ? { key, descending: !sort.descending }
        : { key, descending: DESCENDING_FIRST.has(key) };
    change({ sort: sortParam(next, NEWEST_FIRST) });
  }

  /** Load the next page as the end of the loaded rows scrolls into view. */
  function loadOnReach(node: HTMLElement) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void list.more();
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  /**
   * Read whenever the address changes. Arriving from another page, the search
   * box shows the address's search; while someone types here, the box leads
   * and the address follows.
   */
  afterNavigate(({ from }) => {
    if (from?.url?.pathname !== page.url.pathname) search = params.get("q") ?? "";
    load();
  });

  // A search still settling must not change the address of a page that has gone.
  onDestroy(() => clearTimeout(settling));

  /**
   * The revision this list has already read for.
   *
   * Deliberately not `$state`: the effect below must depend on the engine's
   * revision alone. Making this reactive would have the effect re-run on its
   * own write, which converges but does so by running twice for every change.
   */
  let seen = 0;

  // The engine indexes in the background; re-read when it finds something.
  $effect(() => {
    if (engine.revision !== seen) {
      seen = engine.revision;
      void list.refresh();
    }
  });

  const loaded = $derived(list.sessions.length);
  const noun = $derived(spawned ? "sessions" : "conversations");

  /**
   * What the title block says about the list.
   *
   * The totals belong here rather than at the foot of the page: they describe
   * the whole match, not the rows that happen to be loaded, and a reader who
   * has not scrolled has no other way to learn them.
   */
  const describing = $derived.by(() => {
    if (list.phase === "initial") return "Reading your conversations…";
    const named = [
      agent === null ? noun : `${agentName(agent)} ${noun}`,
      project === null ? "" : ` in ${projectName(project)}`,
      model === null ? "" : ` using ${model}`,
    ].join("");
    const counted =
      loaded >= list.total
        ? `${formatCount(list.total)} ${named}`
        : `${formatCount(loaded)} of ${formatCount(list.total)} ${named}`;
    const tokens = list.tokens.total > 0 ? `${formatCountCompact(list.tokens.total)} tokens` : null;
    const cost = list.costUsd === null ? null : formatUsd(list.costUsd);
    return [counted, days?.label, tokens, cost].filter(Boolean).join(" · ");
  });
</script>

<svelte:head><title>Sessions · Overwatch</title></svelte:head>

<PageHeader title="Sessions" description={describing}>
  {#snippet icon()}<SquareTerminal {...pageIcon} />{/snippet}
  {#snippet actions()}
    <!-- A column's days are no period, so while they narrow the list none is chosen. -->
    <Segmented
      options={PERIODS}
      value={days === null ? period : undefined}
      onchange={(next) => change({ period: periodParam(next, ALL_TIME), from: null, to: null })}
    />
  {/snippet}
</PageHeader>

<div class="flex flex-wrap items-center gap-2">
  <div class="relative min-w-56 flex-1">
    <Search
      class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
      size={15}
      aria-hidden="true"
    />
    <input
      class="h-9 w-full rounded-control border border-border bg-menu pr-3 pl-8 placeholder:text-muted"
      id="search"
      type="search"
      placeholder="Search sessions, projects, or models…"
      aria-label="Search sessions"
      bind:value={search}
      oninput={scheduleSearch}
    />
  </div>
  <Segmented
    options={[
      { value: false, label: "Conversations" },
      { value: true, label: "All runs" },
    ]}
    value={spawned}
    onchange={(include) => change({ runs: include ? "all" : null })}
  />

  {#if agent !== null}
    <a
      class={CHIP}
      href={withParams(page.url, { agent: null })}
      aria-label="Show all agents, not only {agentName(agent)}"
    >
      <AgentMark {agent} size={14} class="shrink-0 text-muted" />
      <span>{agentName(agent)}</span>
      <X class="shrink-0 text-muted" size={14} aria-hidden="true" />
    </a>
  {/if}

  {#if project !== null}
    <a
      class={CHIP}
      href={withParams(page.url, { project: null })}
      title={project}
      aria-label="Show every project, not only {projectName(project)}"
    >
      <Folder class="shrink-0 text-muted" size={14} aria-hidden="true" />
      <span class="truncate">{projectName(project)}</span>
      <X class="shrink-0 text-muted" size={14} aria-hidden="true" />
    </a>
  {/if}

  {#if model !== null}
    <a
      class={CHIP}
      href={withParams(page.url, { model: null })}
      aria-label="Show every model, not only {model}"
    >
      <Layers class="shrink-0 text-muted" size={14} aria-hidden="true" />
      <span class="truncate font-mono text-meta">{model}</span>
      <X class="shrink-0 text-muted" size={14} aria-hidden="true" />
    </a>
  {/if}

  {#if days !== null}
    <a
      class={CHIP}
      href={withParams(page.url, { from: null, to: null })}
      aria-label="Show every day, not only {days.label}"
    >
      <Calendar class="shrink-0 text-muted" size={14} aria-hidden="true" />
      <span>{days.label}</span>
      <X class="shrink-0 text-muted" size={14} aria-hidden="true" />
    </a>
  {/if}
</div>

{#if list.phase === "error" && loaded === 0}
  <div class="mt-6 grid justify-items-start gap-3">
    <p role="alert">Could not load sessions.</p>
    <code class="text-meta text-muted">{list.error}</code>
    <button class="h-9 rounded-control bg-active px-3" onclick={() => void list.refresh()}>
      Retry
    </button>
  </div>
{:else if list.phase === "initial"}
  <div class="mt-5 grid gap-2" aria-hidden="true">
    {#each Array.from({ length: 7 }, (_, index) => index) as row (row)}
      <div class="h-12 animate-pulse rounded-control bg-hover"></div>
    {/each}
  </div>
{:else if loaded === 0}
  <div class="mt-6 grid justify-items-start gap-2">
    <p>No sessions match.</p>
    <p class="text-muted">
      {search.trim() !== ""
        ? "Try a different search."
        : days !== null || period !== ALL_TIME || project !== null || model !== null
          ? `No ${noun} match what the list is narrowed to.`
          : agent === null
            ? "No conversations have been indexed yet."
            : `Nothing from ${agentName(agent)} has been indexed yet.`}
    </p>
  </div>
{:else}
  <div class="mt-4" aria-busy={list.phase === "updating"}>
    <SessionRows
      sessions={list.sessions}
      {sort}
      now={clock.now}
      onsort={toggleSort}
      projectHref={(cwd) => withParams(page.url, { project: cwd })}
      modelHref={(model) => withParams(page.url, { model })}
    />
  </div>

  <div use:loadOnReach class="h-px"></div>

  {#if list.pageError !== null}
    <div class="mt-4 grid justify-items-start gap-2">
      <code class="text-meta text-muted" role="alert">{list.pageError}</code>
      <button class="h-9 rounded-control bg-active px-3" onclick={() => void list.retryPage()}>
        Retry loading more
      </button>
    </div>
  {:else if list.loadingPage}
    <p class="mt-4 text-meta text-muted">Loading more sessions…</p>
  {/if}
{/if}
