<script lang="ts">
  /**
   * The rows of a session list, one line each.
   *
   * A list rather than a table, because a table sizes its columns to their
   * content: one long title widens the whole thing and pushes the numbers off
   * screen. Here the title is the only flexible part and it truncates, so the
   * figures stay in the same place on every row, in the same order as the
   * Models page.
   *
   * Each row opens its session, and its project or model narrows the list to
   * the sessions that share it.
   */
  import { resolve } from "$app/paths";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { Session, Sort, SortKey } from "#lib/api/backend.ts";
  import { sessionLabel } from "#lib/agents.ts";
  import AgentMark from "#lib/components/marks/AgentMark.svelte";
  import SortButton from "#lib/components/ui/SortButton.svelte";
  import {
    UNKNOWN,
    formatCount,
    formatCountCompact,
    formatDateTime,
    formatUsd,
    formatWhen,
    projectName,
  } from "#lib/format.ts";

  interface Props {
    sessions: readonly Session[];
    sort: Sort;
    /** The moment relative times are measured against. */
    now: Date;
    onsort: (key: SortKey) => void;
    /** Where the list narrowed to one project is. */
    projectHref: (cwd: string) => string;
    /** Where the list narrowed to one model is. */
    modelHref: (model: string) => string;
  }

  let { sessions, sort, now, onsort, projectHref, modelHref }: Props = $props();

  /** How recently a session must have been active to count as still going. */
  const LIVE = 2 * 60_000;

  /**
   * Column widths, shared by the header and every row so they stay aligned
   * without a table's layout algorithm.
   */
  const MARK = "w-4";
  const PROJECT = "w-32";
  const MODEL = "w-40";
  const TOKENS = "w-20";
  const COST = "w-24";
  const ACTIVITY = "w-24";
</script>

<div class="flex items-center gap-3 px-2.5 pb-1 text-meta text-muted">
  <span class="{MARK} shrink-0" aria-hidden="true"></span>
  <SortButton
    class="min-w-0 flex-1"
    label="Session"
    active={sort.key === "title"}
    descending={sort.descending}
    onclick={() => onsort("title")}
  />
  <span class="{PROJECT} hidden shrink-0 lg:block">Project</span>
  <span class="{MODEL} hidden shrink-0 xl:block">Model</span>
  <SortButton
    class="{TOKENS} shrink-0 justify-end"
    label="Tokens"
    active={sort.key === "tokens"}
    descending={sort.descending}
    onclick={() => onsort("tokens")}
  />
  <SortButton
    class="{COST} hidden shrink-0 justify-end sm:flex"
    label="Cost"
    active={sort.key === "cost"}
    descending={sort.descending}
    onclick={() => onsort("cost")}
  />
  <SortButton
    class="{ACTIVITY} shrink-0 justify-end"
    label="Last activity"
    active={sort.key === "updated"}
    descending={sort.descending}
    onclick={() => onsort("updated")}
  />
</div>

<ul aria-label="Sessions">
  {#each sessions as session (session.id)}
    {@const live = now.getTime() - session.updatedAt < LIVE}
    {@const [main, ...others] = session.models}
    <!-- The title's link covers the whole row; the project's, and anything
         with a tooltip, sits above it. -->
    <li class="relative flex items-center gap-3 rounded-control px-2.5 py-2 hover:bg-hover">
      <AgentMark agent={session.agent} size={16} class="{MARK} shrink-0 text-muted" />

      <span class="flex min-w-0 flex-1 items-center gap-1.5">
        <a
          class="truncate outline-none after:absolute after:inset-0 after:rounded-control focus-visible:after:outline-2 focus-visible:after:outline-(--focus) {session.title ===
            null && !session.spawned
            ? 'text-muted'
            : ''}"
          href={resolve("/sessions/[id]", { id: session.id })}
          title={session.title ?? undefined}
        >
          {sessionLabel(session)}
        </a>
        {#if session.spawned}
          <span
            class="relative shrink-0 rounded-item bg-active px-1.5 py-0.5 text-label text-muted"
            title="Started by an agent, not by you"
          >
            agent
          </span>
        {/if}
        {#if !session.present}
          <TriangleAlert
            class="relative shrink-0 text-warning"
            size={12}
            aria-label="No longer in its source; the history read so far is kept"
          />
        {/if}
      </span>

      {#if session.cwd === null}
        <span class="{PROJECT} hidden shrink-0 text-muted lg:block">{UNKNOWN}</span>
      {:else}
        <a
          class="relative {PROJECT} hidden shrink-0 truncate text-muted hover:text-text hover:underline lg:block"
          href={projectHref(session.cwd)}
          title="Only sessions in {session.cwd}"
        >
          {projectName(session.cwd)}
        </a>
      {/if}
      {#if main === undefined}
        <span class="{MODEL} hidden shrink-0 text-muted xl:block">{UNKNOWN}</span>
      {:else}
        <a
          class="relative {MODEL} hidden shrink-0 truncate font-mono text-meta text-muted hover:text-text hover:underline xl:block"
          href={modelHref(main.model)}
          title={session.models.map((slice) => slice.model).join(", ")}
        >
          {main.model}{others.length > 0 ? ` +${others.length}` : ""}
        </a>
      {/if}
      <span
        class="relative {TOKENS} shrink-0 text-right tabular-nums {session.tokens.total === 0
          ? 'text-muted'
          : ''}"
        title={session.tokens.total === 0
          ? "No usage was recorded"
          : `${formatCount(session.tokens.total)} tokens`}
      >
        {session.tokens.total === 0 ? UNKNOWN : formatCountCompact(session.tokens.total)}
      </span>
      <span
        class="relative {COST} hidden shrink-0 text-right tabular-nums sm:block {session.costUsd ===
        null
          ? 'text-muted'
          : ''}"
        title={session.costUsd === null ? "No price is listed for this session's models" : ""}
      >
        {formatUsd(session.costUsd)}
      </span>
      <span
        class="relative {ACTIVITY} shrink-0 truncate text-right {live ? '' : 'text-muted'}"
        title={formatDateTime(session.updatedAt)}
      >
        {#if live}
          <span
            class="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-(--live) align-middle"
          ></span>Now
        {:else}
          {formatWhen(session.updatedAt, now)}
        {/if}
      </span>
    </li>
  {/each}
</ul>
