<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { Popover } from "bits-ui";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import Layers from "@lucide/svelte/icons/layers";
  import CreditCard from "@lucide/svelte/icons/credit-card";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import AgentMark from "#lib/components/marks/AgentMark.svelte";
  import { agentName, parseAgent } from "#lib/agents.ts";
  import { formatCount } from "#lib/format.ts";
  import { attention } from "#lib/limits.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { getClock } from "#lib/state/clock.svelte.ts";
  import ThemeMenu from "./ThemeMenu.svelte";
  import { sidebarIcon, sidebarItem } from "./item";

  const engine = getEngine();
  const clock = getClock();

  /** How Subscriptions is marked while a limit needs attention. */
  const ALARM = {
    blocked: { tone: "bg-danger", label: "A limit is used up" },
    running_out: { tone: "bg-warning", label: "A limit is running out" },
  } as const;

  /**
   * A mark rather than a message: it clears itself when the limit recovers, so
   * there is nothing to dismiss, and the page it marks says which and when.
   */
  const alarm = $derived(attention(engine.status.accounts, clock.now.getTime()));

  const items = [
    { href: "/", label: "Overview", icon: LayoutGrid },
    { href: "/sessions", label: "Sessions", icon: SquareTerminal },
    { href: "/models", label: "Models", icon: Layers },
    { href: "/subscriptions", label: "Subscriptions", icon: CreditCard },
  ] as const;

  /** How a link shows it is where the reader is. */
  const currentLink =
    "aria-[current=page]:bg-active aria-[current=page]:font-[550] aria-[current=page]:text-text";

  /**
   * The agent the session list is narrowed to, if it is.
   *
   * A narrowed list is marked on its agent's link rather than on Sessions, so
   * exactly one row says where the reader is.
   */
  const narrowed = $derived(
    page.route.id === "/sessions" ? parseAgent(page.url.searchParams.get("agent")) : null,
  );
</script>

<aside
  class="flex min-h-0 flex-col border-r border-border bg-sidebar px-3 pb-4 select-none"
  aria-label="Sidebar"
>
  <div class="flex h-16 shrink-0 items-center gap-2.5 px-2 pb-2 text-section tracking-[-0.55px]">
    <svg class="shrink-0" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" /><circle
        cx="12"
        cy="12"
        r="3"
        fill="currentColor"
      />
    </svg>
    <span>Overwatch</span>
  </div>

  <nav class="-m-1 flex flex-col gap-1 overflow-y-auto p-1" aria-label="Main navigation">
    {#each items as item (item.href)}
      <a
        class="{sidebarItem} {currentLink}"
        href={resolve(item.href)}
        aria-current={page.route.id === item.href && narrowed === null ? "page" : undefined}
      >
        <item.icon class="shrink-0" {...sidebarIcon} aria-hidden="true" />
        <span>{item.label}</span>
        {#if item.href === "/subscriptions" && alarm !== null}
          <span
            class="ml-auto size-2 shrink-0 rounded-full {ALARM[alarm].tone}"
            role="img"
            aria-label={ALARM[alarm].label}
            title={ALARM[alarm].label}
          ></span>
        {/if}
      </a>
    {/each}

    {#if engine.status.agents.length > 0}
      <h2 class="px-2.75 pt-4 pb-1 text-label text-muted">Agents</h2>
      {#each engine.status.agents as agent (agent)}
        <a
          class="{sidebarItem} {currentLink}"
          href="{resolve('/sessions')}?agent={agent}"
          aria-current={narrowed === agent ? "page" : undefined}
        >
          <!-- Brand marks are solid, so they sit smaller than the stroked icons
               above, centred in the same box to keep the labels aligned. -->
          <span class="flex size-4.5 shrink-0 items-center justify-center">
            <AgentMark {agent} size={15} />
          </span>
          <span>{agentName(agent)}</span>
        </a>
      {/each}
    {/if}
  </nav>

  <div class="mt-auto flex flex-col gap-1 pt-4">
    {#if engine.status.progress}
      {@const [read, total] = engine.status.progress}
      <div
        class="grid gap-1.5 px-2.75 py-2 text-meta text-muted"
        role="progressbar"
        aria-label="Reading history"
        aria-valuemax={total}
        aria-valuenow={read}
      >
        <span class="flex justify-between gap-2">
          <span>Reading history</span>
          <span class="tabular-nums">{formatCount(read)} of {formatCount(total)}</span>
        </span>
        <span class="h-1 overflow-hidden rounded-full bg-hover">
          <span class="block h-full rounded-full bg-active" style="width:{(read / total) * 100}%"
          ></span>
        </span>
      </div>
    {/if}
    {#if engine.status.problems.length > 0}
      <!-- No count: the engine deduplicates and caps what it reports, so a
           number here would understate a badly broken corpus. -->
      <Popover.Root>
        <Popover.Trigger
          class="{sidebarItem} data-[state=open]:bg-hover data-[state=open]:text-text"
        >
          <TriangleAlert class="shrink-0 text-danger" {...sidebarIcon} aria-hidden="true" />
          <span>Skipped sources</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            class="z-30 w-96 max-w-[calc(100vw-16px)] rounded-menu border border-border bg-menu p-3 shadow-[0_8px_30px_#00000018,0_2px_6px_#0000000a]"
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={8}
          >
            <p class="text-label text-muted">Sources the last scan could not read</p>
            <ul class="mt-2 grid max-h-72 gap-1 overflow-y-auto">
              {#each engine.status.problems as problem, index (index)}
                <li class="rounded-item bg-hover px-2 py-1.5 font-mono text-meta wrap-anywhere">
                  {problem}
                </li>
              {/each}
            </ul>
            <p class="mt-2 text-meta text-muted">
              Each was skipped; the rest of the scan carried on without it.
            </p>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    {/if}
    <ThemeMenu />
  </div>
</aside>

<style>
  /* The current destination carries a rail marker the utilities cannot draw. */
  a[aria-current="page"]::before {
    content: "";
    position: absolute;
    left: 0;
    width: 2px;
    height: 14px;
    border-radius: 2px;
    background: var(--text);
  }
</style>
