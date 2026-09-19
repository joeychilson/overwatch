<script module lang="ts">
  import { SessionList } from "#lib/state/sessions.svelte.ts";
  import { ConversationSearch } from "#lib/state/conversation-search.svelte.ts";

  // Kept between visits, so coming back from a session shows the rows at once
  // and where they were, rather than reading and scrolling all over again.
  const list = new SessionList();
  const conversations = new ConversationSearch();
</script>

<script lang="ts">
  /**
   * Every session, newest first.
   *
   * What the list shows lives in its address, so opening a session and going
   * back returns to the same list, and the app's menu can open it searching.
   *
   * A full-text search looks through what was said in every conversation the
   * list is narrowed to, reading the agents' own files, so it runs when the
   * search changes rather than whenever the index does, and what it finds is
   * ordered here.
   */
  import { onDestroy } from "svelte";
  import { afterNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import Calendar from "@lucide/svelte/icons/calendar";
  import Clock from "@lucide/svelte/icons/clock";
  import Folder from "@lucide/svelte/icons/folder";
  import Layers from "@lucide/svelte/icons/layers";
  import Search from "@lucide/svelte/icons/search";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import type { Filter, Session, SortKey } from "#lib/api/backend.ts";
  import Failure from "#lib/components/ui/Failure.svelte";
  import PageHeader, { pageIcon } from "#lib/components/ui/PageHeader.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import AgentMark from "#lib/components/marks/AgentMark.svelte";
  import Chip from "#lib/components/sessions/Chip.svelte";
  import SessionRows from "#lib/components/sessions/SessionRows.svelte";
  import { agentName, parseAgent } from "#lib/agents.ts";
  import { onReach } from "#lib/attachments.ts";
  import { REPLACE, withParams } from "#lib/address.ts";
  import {
    HOUR,
    PERIODS,
    addDays,
    parseDayKey,
    parseHour,
    parsePeriod,
    periodParam,
    periodStart,
  } from "#lib/periods.ts";
  import { parseSort, sortParam, sorted, toggled } from "#lib/sort.ts";
  import { now } from "#lib/state/clock.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { ALL_TIME, NEWEST_FIRST } from "#lib/state/sessions.svelte.ts";
  import {
    formatCount,
    formatCountCompact,
    formatDays,
    formatHours,
    formatUsd,
    projectName,
  } from "#lib/format.ts";

  const engine = getEngine();

  /** Each column the list orders by, by how a session measures in it. */
  const COLUMNS: Record<SortKey, (session: Session) => number | string | null> = {
    updated: (session) => session.updatedAt,
    started: (session) => session.startedAt,
    tokens: (session) => session.tokens.total,
    cost: (session) => session.costUsd,
    title: (session) => session.title,
  };
  const SORT_KEYS = Object.keys(COLUMNS) as SortKey[];
  /** Recency and size read newest and largest first; a title reads A to Z. */
  const DESCENDING_FIRST: ReadonlySet<SortKey> = new Set(["updated", "started", "tokens", "cost"]);

  /**
   * How long typing settles before it is sent: longer in full text, where each
   * search reads every conversation.
   */
  const SETTLE_MS = 150;
  const SETTLE_TEXT_MS = 400;

  const params = $derived(page.url.searchParams);
  /** A key naming no agent is dropped rather than sent, since the engine would refuse the read. */
  const agent = $derived(parseAgent(params.get("agent")));
  const period = $derived(parsePeriod(params.get("period"), ALL_TIME));
  /** The days of a column of the overview's chart, which are narrower than any period. */
  const days = $derived.by(() => {
    const from = parseDayKey(params.get("from"));
    const to = parseDayKey(params.get("to"));
    return from === null || to === null ? null : { from, to };
  });
  /** The hour of a column of the overview's chart of today, narrower still. */
  const hour = $derived(parseHour(params.get("hour")));
  /** The column's days or hour, as the list names them. */
  const span = $derived(
    hour !== null ? formatHours(hour, hour, now()) : days && formatDays(days.from, days.to, now()),
  );
  const project = $derived(params.get("project"));
  const model = $derived(params.get("model"));
  /**
   * Whether runs an agent started itself are listed. They far outnumber the
   * conversations people had, so the list opens without them and says so.
   */
  const spawned = $derived(params.get("runs") === "all");
  /** Whether a search looks through what was said rather than at titles. */
  const text = $derived(params.get("text") === "1");
  const query = $derived(params.get("q")?.trim() ?? "");
  const sort = $derived(parseSort(params.get("sort"), SORT_KEYS, NEWEST_FIRST));

  /** What the list is narrowed to, besides its search and ordering. */
  const narrowed = $derived<Filter>({
    agents: agent === null ? [] : [agent],
    // A column's days run from the first's midnight to the instant before the
    // one after the last, and its hour to the instant before the next.
    since: hour ?? days?.from ?? periodStart(period) ?? null,
    until: hour !== null ? hour + HOUR - 1 : days === null ? null : addDays(days.to, 1) - 1,
    project,
    model,
    includeSpawned: spawned,
  });
  /** Whether the list is what a search of what was said found. */
  const fullText = $derived(text && query !== "");

  // The rows are owned rather than awaited, since they accumulate, so they are
  // kept in step here with what the address and the index say.
  $effect(() => {
    if (fullText) {
      conversations.run(query, { ...narrowed, search: null });
    } else {
      conversations.stop();
      list.show({ ...narrowed, search: query || null, sort }, engine.revision);
    }
  });

  /** What is in the search box; the address follows it once typing settles. */
  let search = $state(page.url.searchParams.get("q") ?? "");
  let searchBox = $state<HTMLInputElement>();
  let rows = $state<ReturnType<typeof SessionRows>>();
  let settling: ReturnType<typeof setTimeout> | undefined;

  // Typing leads the address; anything else that changes it leads the box.
  afterNavigate(({ type }) => {
    if (type !== "goto") search = params.get("q") ?? "";
  });
  onDestroy(() => clearTimeout(settling));

  /** Show the list with some of what the address says changed, in place. */
  function change(changes: Record<string, string | null>) {
    void goto(withParams(page.url, changes), REPLACE);
  }

  function scheduleSearch() {
    clearTimeout(settling);
    settling = setTimeout(
      () => change({ q: search.trim() || null }),
      text ? SETTLE_TEXT_MS : SETTLE_MS,
    );
  }

  function toggleSort(key: SortKey) {
    change({ sort: sortParam(toggled(sort, key, DESCENDING_FIRST), NEWEST_FIRST) });
  }

  /** What a search of what was said found, in the list's ordering. */
  const found = $derived(
    sorted(
      conversations.mentions.map((mention) => mention.session),
      COLUMNS[sort.key],
      sort.descending,
    ),
  );
  const quotes = $derived(
    new Map(conversations.mentions.map((mention) => [mention.session.id, mention])),
  );
  const noun = $derived(spawned ? "sessions" : "conversations");

  /**
   * What the header says about the list. The totals belong here: they are of
   * the whole match, which a reader who has not scrolled cannot see otherwise.
   */
  const describing = $derived.by(() => {
    if (fullText) {
      const count = conversations.mentions.length;
      const searched = conversations.searched;
      if (conversations.phase === "error") return "Could not search the conversations";
      if (searched === null) return `Reading conversations… ${formatCount(count)} found so far`;
      const counted = `${formatCount(count)} ${count === 1 ? "conversation mentions" : "conversations mention"} “${query}”`;
      return searched.capped
        ? `${counted}, the most recent shown`
        : `${counted} · ${formatCount(searched.searched)} read`;
    }
    if (list.phase === "initial") return "Reading your conversations…";
    const named = [
      agent === null ? noun : `${agentName(agent)} ${noun}`,
      project === null ? "" : ` in ${projectName(project)}`,
      model === null ? "" : ` using ${model}`,
    ].join("");
    const loaded = list.sessions.length;
    const counted =
      loaded >= list.total
        ? `${formatCount(list.total)} ${named}`
        : `${formatCount(loaded)} of ${formatCount(list.total)} ${named}`;
    const tokens = list.tokens.total > 0 ? `${formatCountCompact(list.tokens.total)} tokens` : null;
    const cost = list.costUsd === null ? null : formatUsd(list.costUsd);
    return [counted, span, tokens, cost].filter(Boolean).join(" · ");
  });

  /** Why nothing matches, when nothing does. */
  const unmatched = $derived.by(() => {
    if (query !== "") return "Try a different search.";
    if (
      hour !== null ||
      days !== null ||
      period !== ALL_TIME ||
      project !== null ||
      model !== null
    ) {
      return `No ${noun} match what the list is narrowed to.`;
    }
    return agent === null
      ? "No conversations have been indexed yet."
      : `Nothing from ${agentName(agent)} has been indexed yet.`;
  });
</script>

<svelte:head><title>Sessions · Overwatch</title></svelte:head>

{#snippet skeleton()}
  <div class="mt-5 grid gap-2" aria-hidden="true">
    {#each { length: 7 }, row (row)}
      <div class="h-12 animate-pulse rounded-control bg-hover"></div>
    {/each}
  </div>
{/snippet}

{#snippet rowsOf(
  sessions: readonly Session[],
  busy: boolean,
  empty: { title: string; description: string },
  searched = false,
)}
  <div class="mt-4" aria-busy={busy}>
    <SessionRows
      {empty}
      bind:this={rows}
      {sessions}
      {sort}
      onsort={toggleSort}
      projectHref={(cwd) => withParams(page.url, { project: cwd })}
      modelHref={(model) => withParams(page.url, { model })}
      onabove={() => searchBox?.focus()}
      found={searched ? { query, quotes } : undefined}
    />
  </div>
{/snippet}

<PageHeader title="Sessions" description={describing}>
  {#snippet icon()}<SquareTerminal {...pageIcon} />{/snippet}
  {#snippet actions()}
    <!-- A column's days or hour are no period, so while they narrow the list none is chosen. -->
    <Segmented
      options={PERIODS}
      value={days === null && hour === null ? period : undefined}
      onchange={(next) =>
        change({ period: periodParam(next, ALL_TIME), from: null, to: null, hour: null })}
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
      placeholder={text
        ? "Search what was said in every conversation…"
        : "Search sessions, projects, or models…"}
      aria-label="Search sessions"
      bind:value={search}
      bind:this={searchBox}
      oninput={scheduleSearch}
      onkeydown={(event) => {
        // The down arrow carries on from the search into the rows it found.
        if (event.key === "ArrowDown" && rows?.focusFirst()) event.preventDefault();
      }}
    />
  </div>
  <Segmented
    options={[
      { value: false, label: "Titles" },
      { value: true, label: "Full text" },
    ]}
    value={text}
    onchange={(full) => change({ text: full ? "1" : null })}
  />
  <Segmented
    options={[
      { value: false, label: "Conversations" },
      { value: true, label: "All runs" },
    ]}
    value={spawned}
    onchange={(include) => change({ runs: include ? "all" : null })}
  />

  {#if agent !== null}
    <Chip
      href={withParams(page.url, { agent: null })}
      label="Show all agents, not only {agentName(agent)}"
    >
      <AgentMark {agent} size={14} class="shrink-0 text-muted" />
      <span>{agentName(agent)}</span>
    </Chip>
  {/if}
  {#if project !== null}
    <Chip
      href={withParams(page.url, { project: null })}
      label="Show every project, not only {projectName(project)}"
      title={project}
    >
      <Folder class="shrink-0 text-muted" size={14} aria-hidden="true" />
      <span class="truncate">{projectName(project)}</span>
    </Chip>
  {/if}
  {#if model !== null}
    <Chip href={withParams(page.url, { model: null })} label="Show every model, not only {model}">
      <Layers class="shrink-0 text-muted" size={14} aria-hidden="true" />
      <span class="truncate font-mono text-meta">{model}</span>
    </Chip>
  {/if}
  {#if hour !== null}
    <Chip href={withParams(page.url, { hour: null })} label="Show every hour, not only {span}">
      <Clock class="shrink-0 text-muted" size={14} aria-hidden="true" />
      <span>{span}</span>
    </Chip>
  {:else if days !== null}
    <Chip
      href={withParams(page.url, { from: null, to: null })}
      label="Show every day, not only {span}"
    >
      <Calendar class="shrink-0 text-muted" size={14} aria-hidden="true" />
      <span>{span}</span>
    </Chip>
  {/if}
</div>

{#if fullText}
  {#if conversations.phase === "error"}
    <Failure
      class="mt-6"
      title="Could not search the conversations."
      error={conversations.error}
      onretry={() => conversations.run(query, { ...narrowed, search: null })}
    />
  {:else if found.length === 0 && conversations.phase === "searching"}
    {@render skeleton()}
  {:else}
    {@render rowsOf(
      found,
      conversations.phase === "searching",
      {
        title: "No conversation mentions that",
        description: "Try other words, or a list narrowed to less.",
      },
      true,
    )}
  {/if}
{:else if list.phase === "error" && list.sessions.length === 0}
  <Failure
    class="mt-6"
    title="Could not load sessions."
    error={list.error}
    onretry={() => list.refresh()}
  />
{:else if list.phase === "initial"}
  {@render skeleton()}
{:else}
  {@render rowsOf(list.sessions, list.phase === "updating", {
    title: "No sessions match",
    description: unmatched,
  })}
  <div class="h-px" {@attach onReach(() => list.more())}></div>

  {#if list.pageError !== null}
    <Failure
      class="mt-4"
      error={list.pageError}
      onretry={() => list.more()}
      retry="Retry loading more"
    />
  {:else if list.loadingPage}
    <p class="mt-4 text-meta text-muted">Loading more sessions…</p>
  {/if}
{/if}
