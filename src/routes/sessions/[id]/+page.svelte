<script lang="ts">
  /**
   * One session.
   *
   * The read is an `await` inside the boundary below, not a request fired from
   * an effect. Svelte owns the asynchrony: the read re-runs when the route
   * parameter changes, the previous session stays on screen while the next one
   * loads, a result that arrives after a newer one is discarded, and a failure
   * lands in the boundary with a way to try again.
   *
   * The page shows in stages. The header comes from the index at once; the
   * timeline, the counts taken from it and the conversation each wait for
   * the conversation to be parsed, which for a long session takes a moment,
   * and fill in when it is. A session whose file has gone has no timeline, and
   * its conversation says why.
   *
   * The header is read again whenever the index changes, and the timeline when
   * that finds the session active since. The conversation watches the session
   * itself and reads its newest turns whenever a scan reads anything new of
   * it, so a session still going fills in as its agent works.
   *
   * Finding within the conversation takes the menu's Find commands while the
   * page is open, and keeps its search in the address as `find`.
   */
  import { onMount, tick } from "svelte";
  import { afterNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Check from "@lucide/svelte/icons/check";
  import ClipboardCopy from "@lucide/svelte/icons/clipboard-copy";
  import FileSearch from "@lucide/svelte/icons/file-search";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import Search from "@lucide/svelte/icons/search";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import {
    getSession,
    getTimeline,
    getTranscript,
    openSessionFolder,
    revealSession,
    type Session,
    type Turn,
  } from "#lib/api/backend.ts";
  import AgentMark from "#lib/components/marks/AgentMark.svelte";
  import CopyButton from "#lib/components/ui/CopyButton.svelte";
  import PageHeader, { pageIcon } from "#lib/components/ui/PageHeader.svelte";
  import Timeline from "#lib/components/charts/Timeline.svelte";
  import Transcript from "#lib/components/transcript/Transcript.svelte";
  import { REPLACE, withParams } from "#lib/address.ts";
  import { getCommands } from "#lib/commands.ts";
  import { agentName, isLive, resumeCommand, roleName, sessionLabel } from "#lib/agents.ts";
  import { errorLine } from "#lib/errors.ts";
  import { activeTime, asMarkdown } from "#lib/transcript.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { getClock } from "#lib/state/clock.svelte.ts";
  import {
    UNKNOWN,
    formatCount,
    formatCountCompact,
    formatDuration,
    formatElapsed,
    formatProject,
    formatSpan,
    formatUsd,
  } from "#lib/format.ts";

  const engine = getEngine();
  const clock = getClock();

  const commands = getCommands();

  const sessionId = $derived(page.params.id ?? "");
  /** What is being found in the conversation; null while the find bar is closed. */
  const finding = $derived(page.url.searchParams.get("find"));

  let transcript = $state<ReturnType<typeof Transcript>>();

  /** Open the find bar, or return to it, with its search ready to replace. */
  async function find() {
    if (finding === null) await goto(withParams(page.url, { find: "" }), REPLACE);
    await tick();
    await transcript?.find();
  }

  /** Step through what was found, opening the find bar first if it is closed. */
  function step(direction: 1 | -1) {
    if (finding === null) void find();
    else transcript?.step(direction);
  }

  onMount(() => {
    const taken = [
      commands.take("find", () => void find()),
      commands.take("find_next", () => step(1)),
      commands.take("find_previous", () => step(-1)),
    ];
    return () => taken.forEach((give) => give());
  });
  /** Whether the resume command was just copied. */
  let copied = $state(false);
  /** Why the last action outside the window failed, if it did. */
  let problem = $state<string | null>(null);

  /**
   * Whether the session was opened from the session list, so that going back
   * returns to the list as it was left: searched, ordered and scrolled.
   */
  let fromList = false;
  afterNavigate(({ from }) => {
    if (from?.route?.id !== page.route.id) fromList = from?.url?.pathname === "/sessions";
  });

  /**
   * The session as the index has it, read again whenever the index changes.
   *
   * The revision is a parameter so that the read depends on it: Svelte runs it
   * again for each change and keeps the header on screen meanwhile.
   */
  async function readSession(id: string, revision: number) {
    void revision;
    return getSession(id);
  }

  /**
   * Where every turn falls, read once for both the timeline and the counts,
   * and again when the session has been active since.
   *
   * It takes the whole conversation parsed, which for a long session is a
   * moment's work, so the header shows from the index at once and these fill
   * in when the read is done. Null when the file cannot be read, which the
   * conversation below explains.
   */
  function readTimeline(id: string, activeAt: number) {
    void activeAt;
    return getTimeline(id).catch(() => null);
  }

  async function copy(command: string) {
    problem = null;
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch (error) {
      problem = errorLine(error);
    }
  }

  function act(action: Promise<void>) {
    problem = null;
    action.catch((error: unknown) => (problem = errorLine(error)));
  }

  /** The line under the title: the agent, where and when it worked, and what a spawned run was for. */
  function about(session: Session) {
    return [
      agentName(session.agent),
      session.cwd && formatProject(session.cwd, 3),
      session.branch,
      formatSpan(session.startedAt, session.updatedAt),
      session.spawned && roleName(session.role),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  /** The most turns the engine hands over at once. */
  const LARGEST_PAGE = 2_000;

  /**
   * The whole conversation as Markdown, however much of it is on screen.
   *
   * The engine holds the conversation it parsed for this page, so reading it
   * all again is a slice per page rather than another parse.
   */
  async function conversation(session: Session): Promise<string> {
    const turns: Turn[] = [];
    let total = Infinity;
    while (turns.length < total) {
      const read = await getTranscript(session.id, turns.length, LARGEST_PAGE);
      total = read.total;
      if (read.turns.length === 0) break;
      turns.push(...read.turns);
    }
    return asMarkdown({
      title: sessionLabel(session),
      about: about(session),
      agent: agentName(session.agent),
      turns,
      now: new Date(),
    });
  }
</script>

<svelte:head><title>Session · Overwatch</title></svelte:head>

{#snippet figure(label: string, value: string)}
  <div>
    <dt class="text-meta text-muted">{label}</dt>
    <dd class="mt-0.5 text-section tabular-nums">{value}</dd>
  </div>
{/snippet}

<a
  class="mb-3 -ml-2 inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-muted hover:bg-hover hover:text-text"
  href={resolve("/sessions")}
  onclick={(event) => {
    if (!fromList) return;
    event.preventDefault();
    history.back();
  }}
>
  <ArrowLeft class="shrink-0" size={15} aria-hidden="true" />
  <span>Back to sessions</span>
</a>

<svelte:boundary>
  {#snippet pending()}
    <!-- The header's height, so nothing moves when the session arrives. -->
    <div class="grid gap-6" aria-hidden="true">
      <div class="h-[calc(2.25rem+1lh)] w-2/3 animate-pulse rounded-control bg-hover"></div>
      <div class="h-16 animate-pulse rounded-control bg-hover"></div>
    </div>
  {/snippet}

  {#snippet failed(error, reset)}
    <div role="alert">
      <PageHeader title="Could not open this session." description={errorLine(error)}>
        {#snippet icon()}<TriangleAlert {...pageIcon} />{/snippet}
      </PageHeader>
    </div>
    <button
      class="flex h-9 items-center gap-2 rounded-control bg-active px-3"
      onclick={() => reset()}
    >
      <RotateCcw class="shrink-0" size={14} aria-hidden="true" />
      <span>Try again</span>
    </button>
  {/snippet}

  {@const session = await readSession(sessionId, engine.revision)}
  {@const resume = resumeCommand(session)}
  <!-- A number, so the timeline is read again only when the session was active
       since, not on every read of an unchanged session. -->
  {@const activeAt = session.updatedAt}
  {@const timeline = readTimeline(sessionId, activeAt)}

  <PageHeader title={sessionLabel(session)} description={about(session)}>
    {#snippet icon()}
      <!-- A brand mark is solid, so it sits a little smaller than a stroked icon. -->
      <AgentMark agent={session.agent} size={20} />
    {/snippet}
    {#snippet actions()}
      {#if isLive(session, clock.now.getTime())}
        <span
          class="flex items-center gap-1.5 text-meta text-(--live)"
          title="Active in the last two minutes; what its agent adds appears here"
        >
          <span class="size-1.5 animate-pulse rounded-full bg-(--live)" aria-hidden="true"></span>
          Live
        </span>
      {/if}
      <!-- One control in the shape of a segmented one, so the actions sit
           beside the title without outweighing it. -->
      <div class="flex h-9 items-center gap-0.5 rounded-control border border-border p-0.5">
        {#if resume}
          <button
            class="flex h-full items-center gap-1.5 rounded-item px-2.5 hover:bg-hover"
            title={resume}
            aria-label="Copy resume command"
            onclick={() => copy(resume)}
          >
            {#if copied}
              <Check class="shrink-0" size={15} aria-hidden="true" />
            {:else}
              <SquareTerminal class="shrink-0 text-muted" size={15} aria-hidden="true" />
            {/if}
            <!-- Both words hold the space, so confirming the copy moves nothing. -->
            <span class="grid">
              <span class="col-start-1 row-start-1 {copied ? 'invisible' : ''}">Resume</span>
              <span class="col-start-1 row-start-1 {copied ? '' : 'invisible'}">Copied</span>
            </span>
          </button>
          <span class="mx-0.5 h-4 w-px bg-border" aria-hidden="true"></span>
        {/if}
        <CopyButton
          text={() => conversation(session)}
          label="Copy the conversation as Markdown"
          icon={ClipboardCopy}
          size={15}
          class="aspect-square h-full hover:bg-hover"
        />
        <button
          class="grid aspect-square h-full place-items-center rounded-item text-muted hover:bg-hover hover:text-text"
          title="Find in the conversation (⌘F)"
          aria-label="Find in the conversation"
          onclick={find}
        >
          <Search size={15} aria-hidden="true" />
        </button>
        {#if session.cwd}
          <button
            class="grid aspect-square h-full place-items-center rounded-item text-muted hover:bg-hover hover:text-text"
            title="Open the project folder"
            aria-label="Open the project folder"
            onclick={() => act(openSessionFolder(session.id))}
          >
            <FolderOpen size={15} aria-hidden="true" />
          </button>
        {/if}
        <button
          class="grid aspect-square h-full place-items-center rounded-item text-muted hover:bg-hover hover:text-text"
          title="Show the session file"
          aria-label="Show the session file"
          onclick={() => act(revealSession(session.id))}
        >
          <FileSearch size={15} aria-hidden="true" />
        </button>
      </div>
    {/snippet}
  </PageHeader>

  {#if problem !== null}
    <p class="mb-4 text-meta text-danger" role="alert">{problem}</p>
  {/if}

  {#if !session.present}
    <p class="mb-4 rounded-control border border-warning/30 px-3 py-2 text-warning">
      This conversation is no longer in its source. Overwatch kept what it had already read.
    </p>
  {/if}

  <dl class="flex flex-wrap gap-x-10 gap-y-3" aria-busy={$effect.pending() > 0}>
    {@render figure("Cost", formatUsd(session.costUsd))}
    {@render figure(
      "Tokens",
      session.tokens.total === 0 ? UNKNOWN : formatCountCompact(session.tokens.total),
    )}
    <!-- Counted from the conversation, so they arrive with it. -->
    <svelte:boundary>
      {#snippet pending()}
        {#each ["Active", "Messages", "Tool calls"] as label (label)}
          <div aria-hidden="true">
            <dt class="text-meta text-muted">{label}</dt>
            <dd class="mt-1.5 h-4 w-12 animate-pulse rounded-item bg-hover"></dd>
          </div>
        {/each}
      {/snippet}

      {@const marks = await timeline}
      {@const active = marks === null ? null : activeTime(marks)}
      {@const said = marks?.filter(
        (mark) => mark.speaker === "user" || mark.speaker === "assistant",
      )}
      {@render figure(
        "Active",
        active === null
          ? formatElapsed(session.startedAt, session.updatedAt)
          : formatDuration(active / 1000),
      )}
      {@render figure("Messages", formatCount(said?.length ?? session.messages))}
      {@render figure(
        "Tool calls",
        formatCount(marks?.filter((mark) => mark.speaker === "tool").length ?? session.tools),
      )}
    </svelte:boundary>
    {#if session.models.length > 0}
      <div class="min-w-0">
        <dt class="text-meta text-muted">{session.models.length === 1 ? "Model" : "Models"}</dt>
        <dd class="mt-0.5 flex flex-wrap gap-x-3 font-mono text-meta leading-5.5">
          {#each session.models as slice (slice.model)}
            <span title="{formatCount(slice.tokens.total)} tokens · {formatUsd(slice.costUsd)}">
              {slice.model}
            </span>
          {/each}
        </dd>
      </div>
    {/if}
  </dl>

  <svelte:boundary>
    {#snippet pending()}
      <div class="mt-6 h-15.5 animate-pulse rounded-control bg-hover" aria-hidden="true"></div>
    {/snippet}

    {@const marks = await timeline}
    {#if marks !== null && marks.length > 1}
      <div class="mt-6">
        <Timeline {marks} agent={session.agent} onselect={(index) => transcript?.reveal(index)} />
      </div>
    {/if}
  </svelte:boundary>

  <section class="mt-8" aria-label="Conversation">
    <Transcript
      bind:this={transcript}
      {sessionId}
      agent={agentName(session.agent)}
      {finding}
      onquery={(query) => void goto(withParams(page.url, { find: query }), REPLACE)}
      onclose={() => void goto(withParams(page.url, { find: null }), REPLACE)}
    />
  </section>
</svelte:boundary>
