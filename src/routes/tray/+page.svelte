<script lang="ts">
  /**
   * The panel the menu bar item drops down: how much of each subscription is
   * left, what today has used so far, and the ways to open the window and to
   * quit, which only the panel offers while the window is closed and the app
   * is out of the Dock.
   *
   * The accounts the menu bar's figure follows come first and open, showing
   * every limit: those in use, or else the one used last. The rest stand one
   * line each, ringed as the menu bar's mark is by what their tightest limit
   * has left, and open with a click. The panel starts from that again each
   * time it is put away, as a menu does. An account whose limits can no
   * longer be read keeps the last ones, faded and dated; one with none read
   * yet has nothing to open and stands last.
   *
   * It is drawn on its window's material, which takes the window's appearance,
   * so the window is given the app's: the light theme's text on a dark
   * material would be unreadable. The window takes the size of what it holds.
   * It answers the keys a menu does, and hides on Escape; the engine hides it
   * once anything else is clicked.
   */
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CreditCard from "@lucide/svelte/icons/credit-card";
  import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
  import { mode } from "mode-watcher";
  import { SvelteMap } from "svelte/reactivity";
  import LimitRing from "#lib/components/limits/LimitRing.svelte";
  import LimitRow from "#lib/components/limits/LimitRow.svelte";
  import { getOverview, openWindow, quit, type Account } from "#lib/api/backend.ts";
  import {
    UNKNOWN,
    formatCountCompact,
    formatPercent,
    formatRelative,
    formatUsd,
  } from "#lib/format.ts";
  import { PROVIDERS, arrange, band, explain, followed, left, tightest } from "#lib/limits.ts";
  import { periodStart, startOfDay } from "#lib/periods.ts";
  import { now } from "#lib/state/clock.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";

  const engine = getEngine();

  /** A row of the panel, highlighted under the pointer or the keyboard as a menu's item is. */
  const ITEM =
    "flex w-full items-center rounded-item px-2 text-left hover:bg-text/10 focus-visible:bg-text/10 focus-visible:outline-none";

  const at = $derived(now().getTime());

  const groups = $derived(arrange(engine.status.accounts, at));

  /** The accounts the menu bar follows, which open by themselves. */
  const following = $derived(new Set(followed(engine.status.accounts, at).map(({ id }) => id)));

  /** Accounts opened or closed by hand since the panel was last put away. */
  const toggled = new SvelteMap<string, boolean>();

  function isOpen(account: Account): boolean {
    return toggled.get(account.id) ?? following.has(account.id);
  }

  /** The day it is, which changes only at midnight however often the clock ticks. */
  const day = $derived(startOfDay(at));

  /**
   * What today has used, read again when the index or the day changes. A
   * failure shows as unknown rather than taking the limits down with it.
   */
  function readToday(_revision: number, day: number) {
    return getOverview(periodStart(1, day)).catch(() => null);
  }

  /** Do something with the panel's own window; outside Tauri there is none. */
  function withPanel(action: (panel: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
    try {
      void action(getCurrentWindow()).catch(() => undefined);
    } catch {
      // Not in Tauri.
    }
  }

  /** Size the panel's window to what it holds. */
  function fit(content: HTMLElement) {
    const observer = new ResizeObserver(() => {
      const size = new LogicalSize(content.offsetWidth, content.offsetHeight);
      if (size.width > 0 && size.height > 0) withPanel((panel) => panel.setSize(size));
    });
    observer.observe(content);
    return () => observer.disconnect();
  }

  /** Move the highlight to the next row or the one before, wrapping round, as a menu's arrow keys do. */
  function step(by: 1 | -1) {
    const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")];
    const from = rows.indexOf(document.activeElement as HTMLElement);
    const to = from === -1 ? (by === 1 ? 0 : rows.length - 1) : from + by;
    rows.at(to % rows.length)?.focus();
  }

  function onkeydown(event: KeyboardEvent) {
    // Caps Lock makes the key a capital, which a menu's shortcut ignores.
    const command =
      event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey
        ? event.key.toLowerCase()
        : null;
    if (event.key === "Escape") withPanel((panel) => panel.hide());
    else if (event.key === "ArrowDown") step(1);
    else if (event.key === "ArrowUp") step(-1);
    else if (command === "o") void openWindow();
    else if (command === "q") void quit();
    else return;
    event.preventDefault();
  }

  $effect(() => {
    const theme = mode.current ?? null;
    withPanel((panel) => panel.setTheme(theme));
  });
</script>

<svelte:head><title>Overwatch</title></svelte:head>

<svelte:window {onkeydown} onblur={() => toggled.clear()} />

{#snippet shortcut(keys: string)}
  <kbd class="ml-auto pl-4 font-sans text-muted" aria-hidden="true">{keys}</kbd>
{/snippet}

<!--
  Parts stand apart by space alone, without a menu's separators. Every column
  is held to the panel's width, so a long account name is cut short rather than
  pushing the figures past the window's edge.
-->
<div class="grid w-85 grid-cols-1 gap-2 p-1.5 select-none" {@attach fit}>
  {#snippet todayItem(used: string)}
    <button
      class="{ITEM} h-7 justify-between gap-3"
      title="Open the overview of today"
      data-row
      onclick={() => openWindow("/?period=today")}
    >
      <span>Today</span>
      <span class="text-meta text-muted tabular-nums">{used}</span>
    </button>
  {/snippet}

  <!-- The row holds its place while today is read, so the panel does not jump. -->
  <svelte:boundary>
    {#snippet pending()}{@render todayItem("")}{/snippet}
    {@const today = await readToday(engine.revision, day)}
    {@render todayItem(
      today === null
        ? UNKNOWN
        : `${formatCountCompact(today.tokens.total)} tokens · ${formatUsd(today.costUsd)}`,
    )}
  </svelte:boundary>

  <div class="grid grid-cols-1 gap-2">
    {#each groups as group (group.label)}
      <section class="grid grid-cols-1" aria-label={group.label ?? undefined}>
        {#if group.label}
          <h2 class="px-2 pt-1.5 pb-1 text-label text-muted">{group.label}</h2>
        {/if}
        {#each group.accounts as account (account.id)}
          {@const provider = PROVIDERS[account.provider]}
          {@const limit = tightest(account, at)}
          {@const open = isOpen(account)}
          <!-- Limits the engine can no longer read are the last it could, shown faded. -->
          {@const stale = account.problem !== null}
          <section aria-label={[provider.name, account.label].filter(Boolean).join(" ")}>
            {#snippet summary()}
              <LimitRing
                mark={provider.mark}
                left={limit && left(limit, at)}
                band={limit ? band(limit, at) : "fine"}
                {stale}
              />
              <span class="shrink-0 font-semibold">{provider.name}</span>
              {#if account.label}
                <span class="min-w-0 truncate text-meta text-muted">{account.label}</span>
              {/if}
              <span
                class="ml-auto shrink-0 pl-2 font-medium tabular-nums {stale ? 'text-muted' : ''}"
              >
                {#if !open && limit}
                  {#if band(limit, at) === "blocked"}
                    <span class="text-muted">Limit reached</span>
                  {:else}
                    {formatPercent(left(limit, at))} left
                  {/if}
                {/if}
              </span>
            {/snippet}
            <h3>
              {#if account.limits.length === 0}
                <!-- No limit has been read yet, so there is nothing to open. -->
                <div class="flex h-9 items-center gap-2 px-2">{@render summary()}</div>
              {:else}
                <button
                  class="{ITEM} h-9 gap-2"
                  aria-expanded={open}
                  aria-controls="limits-{account.id}"
                  data-row
                  onclick={() => toggled.set(account.id, !open)}
                >
                  {@render summary()}
                  <ChevronRight
                    class="size-3.5 shrink-0 text-muted transition-transform {open
                      ? 'rotate-90'
                      : ''}"
                    aria-hidden="true"
                  />
                </button>
              {/if}
            </h3>
            {#if stale}
              <p class="-mt-1 pr-7.5 pb-1 pl-10.5 text-meta">
                <span class="text-warning">{explain(account)}</span>
                {#if account.limits.length > 0 && account.readAt !== null}
                  <span class="whitespace-nowrap text-muted"
                    >Last read {formatRelative(account.readAt, now())}.</span
                  >
                {/if}
              </p>
            {/if}
            {#if account.limits.length > 0}
              <ul
                id="limits-{account.id}"
                class="pr-7.5 pb-2 pl-10.5 {stale ? 'opacity-60' : ''}"
                hidden={!open}
              >
                {#each account.limits as limit, index (index)}
                  <LimitRow
                    {limit}
                    readAt={account.readAt}
                    class="grid-cols-[minmax(0,1fr)_auto_auto] [grid-template-areas:'name_when_value'_'bar_bar_bar'] gap-x-2 gap-y-1 not-first:pt-2"
                  />
                {/each}
              </ul>
            {/if}
          </section>
        {/each}
      </section>
    {:else}
      <!-- Where an account would stand, with its ring empty. -->
      <div class="flex gap-2 px-2 py-1.5">
        <span
          class="grid size-6.5 shrink-0 place-items-center rounded-full border-2 border-text/12 text-muted"
        >
          <CreditCard size={12} aria-hidden="true" />
        </span>
        <div class="min-w-0 pt-0.5">
          <p class="font-semibold">No subscriptions found</p>
          <p class="text-meta text-muted">
            Sign in to a subscription in Claude Code, Codex, Grok Build, OpenCode, or Pi, and its
            limits show here.
          </p>
        </div>
      </div>
    {/each}
  </div>

  <div class="grid grid-cols-1 pt-1">
    <button class="{ITEM} h-7" aria-keyshortcuts="Meta+O" data-row onclick={() => openWindow()}>
      Open Overwatch{@render shortcut("⌘O")}
    </button>
    <button class="{ITEM} h-7" aria-keyshortcuts="Meta+Q" data-row onclick={() => quit()}>
      Quit Overwatch{@render shortcut("⌘Q")}
    </button>
  </div>
</div>

<style>
  /* The window is transparent, so its material shows through the page. */
  :global(:root) {
    background: transparent;
  }
</style>
