<script lang="ts">
  /**
   * The panel the menu bar item drops down: how much of each subscription is
   * left, the ones in use first, since those are what the menu bar's figure
   * follows, and what today has used so far, which opens the overview of it.
   *
   * It is drawn on its window's material, which takes the window's appearance,
   * so the window is given the app's: the light theme's text on a dark material
   * would be unreadable. The window takes the size of what it holds. It hides
   * on Escape, and the engine hides it once anything else is clicked, as a menu
   * does.
   */
  import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
  import { mode } from "mode-watcher";
  import Mark from "#lib/components/marks/Mark.svelte";
  import LimitRow from "#lib/components/limits/LimitRow.svelte";
  import { getOverview, openWindow, quit } from "#lib/api/backend.ts";
  import { UNKNOWN, formatCountCompact, formatUsd } from "#lib/format.ts";
  import { PROVIDERS, byUrgency, explain, inUse } from "#lib/limits.ts";
  import { periodStart, startOfDay } from "#lib/periods.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { getClock } from "#lib/state/clock.svelte.ts";

  const engine = getEngine();
  const clock = getClock();

  /** Menu items share one look. */
  const ITEM = "flex h-7 w-full items-center rounded-item px-2 text-left hover:bg-text/10";

  const now = $derived(clock.now.getTime());
  /**
   * The accounts in use and the rest, each nearest to stopping work first. With
   * none in use there is nothing to set apart, so they stand unlabelled.
   */
  const groups = $derived.by(() => {
    const accounts = byUrgency(engine.status.accounts, now);
    const working = accounts.filter((account) => inUse(account, now));
    const groups =
      working.length === 0
        ? [{ label: null, accounts }]
        : [
            { label: "In use", accounts: working },
            { label: "Not in use", accounts: accounts.filter((account) => !inUse(account, now)) },
          ];
    return groups.filter((group) => group.accounts.length > 0);
  });

  /**
   * What today has used, read again when the index changes and when the day
   * does. A failed read shows as unknown and is tried again with the next
   * change, rather than taking the limits down with it.
   */
  async function readToday(revision: number, day: number) {
    void revision;
    return getOverview(periodStart(1, day)).catch(() => null);
  }

  let width = $state(0);
  let height = $state(0);

  /** Do something with the panel's own window; outside Tauri there is none. */
  function withPanel(action: (panel: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
    try {
      void action(getCurrentWindow()).catch(() => undefined);
    } catch {
      // Not in Tauri.
    }
  }

  $effect(() => {
    const size = new LogicalSize(width, height);
    if (width > 0 && height > 0) withPanel((panel) => panel.setSize(size));
  });

  $effect(() => {
    const theme = mode.current ?? null;
    withPanel((panel) => panel.setTheme(theme));
  });
</script>

<svelte:head><title>Overwatch</title></svelte:head>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape") withPanel((panel) => panel.hide());
  }}
/>

<div class="w-85 select-none" bind:clientWidth={width} bind:clientHeight={height}>
  <div class="grid gap-4 px-2 pt-3 pb-2">
    {#each groups as group (group.label)}
      <section class="grid gap-3" aria-label={group.label ?? undefined}>
        {#if group.label}
          <h2 class="-mb-1.5 px-1 text-label text-muted">{group.label}</h2>
        {/if}
        {#each group.accounts as account (account.id)}
          {@const provider = PROVIDERS[account.provider]}
          <section aria-label={[provider.name, account.label].filter(Boolean).join(" ")}>
            <div class="flex min-w-0 items-center gap-2 px-1">
              <Mark name={provider.mark} size={14} class="shrink-0" />
              <h3 class="shrink-0 font-semibold">{provider.name}</h3>
              {#if account.label}
                <span class="min-w-0 truncate text-meta text-muted">{account.label}</span>
              {/if}
            </div>
            {#if account.problem !== null}
              <p class="px-1 pt-0.5 text-meta text-warning">{explain(account)}</p>
            {/if}
            <ul>
              {#each account.limits as limit, index (index)}
                <LimitRow
                  {limit}
                  now={clock.now}
                  class="grid-cols-[minmax(0,1fr)_auto_auto] [grid-template-areas:'name_when_value'_'bar_bar_bar'] gap-x-2 gap-y-1 px-1 pt-2"
                />
              {/each}
            </ul>
          </section>
        {/each}
      </section>
    {:else}
      <p class="px-1 text-muted">No subscriptions found.</p>
    {/each}
  </div>

  {#snippet todayItem(used: string)}
    <button
      class="{ITEM} justify-between gap-3"
      title="Open the overview of today"
      onclick={() => openWindow("/?period=today")}
    >
      <span>Today</span>
      <span class="text-meta text-muted tabular-nums">{used}</span>
    </button>
  {/snippet}

  <div class="mx-1 grid border-t border-text/10 py-1.5">
    <!-- The row holds its place while today is read, so the panel does not jump. -->
    <svelte:boundary>
      {#snippet pending()}{@render todayItem("")}{/snippet}
      {@const today = await readToday(engine.revision, startOfDay(clock.now.getTime()))}
      {@render todayItem(
        today === null
          ? UNKNOWN
          : `${formatCountCompact(today.tokens.total)} tokens · ${formatUsd(today.costUsd)}`,
      )}
    </svelte:boundary>
    <button class={ITEM} onclick={() => openWindow()}>Open Overwatch</button>
    <button class={ITEM} onclick={() => quit()}>Quit Overwatch</button>
  </div>
</div>

<style>
  /* The window is transparent, so its material shows through the page. */
  :global(:root) {
    background: transparent;
  }
</style>
