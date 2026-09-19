<script lang="ts">
  /**
   * How much of each subscription's usage limits is left, one card per
   * account, in the menu bar panel's order: the accounts in use first, each run
   * nearest to stopping work first. The cards stand in one grid rather than
   * under the panel's labels, which would leave rows half empty, so each
   * account in use says so itself. The engine announces every account it
   * reads, so this only presents them.
   *
   * Each card rings the account's mark as the panel does, by what its tightest
   * limit has left, and lists every limit with its bar under it. An account
   * whose limits can no longer be read keeps the last ones, faded and dated,
   * and says how to fix it; one with none read yet says so and goes last.
   */
  import CreditCard from "@lucide/svelte/icons/credit-card";
  import Empty from "#lib/components/ui/Empty.svelte";
  import PageHeader, { pageIcon } from "#lib/components/ui/PageHeader.svelte";
  import LimitRing from "#lib/components/limits/LimitRing.svelte";
  import LimitRow from "#lib/components/limits/LimitRow.svelte";
  import { PROVIDERS, arrange, band, explain, inUse, left, tightest } from "#lib/limits.ts";
  import { now } from "#lib/state/clock.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { formatDateTime, formatRelative } from "#lib/format.ts";

  const engine = getEngine();

  const and = new Intl.ListFormat("en", { type: "conjunction" });

  const at = $derived(now().getTime());
  const accounts = $derived(engine.status.accounts);
  const ordered = $derived(arrange(accounts, at).flatMap((group) => group.accounts));

  /** How many accounts there are and how many are in use, such as `3 accounts · 1 in use`. */
  const summary = $derived.by(() => {
    if (accounts.length === 0) return undefined;
    const counted = `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`;
    const using = accounts.filter((account) => inUse(account, at)).length;
    return using === 0 ? counted : `${counted} · ${using} in use`;
  });
</script>

<svelte:head><title>Subscriptions · Overwatch</title></svelte:head>

<PageHeader title="Subscriptions" description={summary}>
  {#snippet icon()}<CreditCard {...pageIcon} />{/snippet}
</PageHeader>

{#if accounts.length === 0}
  <Empty
    icon={CreditCard}
    title="No subscriptions found"
    description="Overwatch reads Codex, Claude, Grok and OpenCode Go limits with the sign-ins that Codex, Claude Code, Grok Build, OpenCode and Pi keep on this Mac. Sign in to a subscription in any of them and its limits appear here."
  />
{:else}
  <!-- As many columns as fit, so a wide window shows every account at once. -->
  <div class="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-3">
    {#each ordered as account (account.id)}
      {@const provider = PROVIDERS[account.provider]}
      {@const limit = tightest(account, at)}
      <!-- Limits the engine can no longer read are the last it could, shown faded. -->
      {@const stale = account.problem !== null}
      <section
        class="flex min-w-0 flex-col gap-3 rounded-menu bg-sidebar p-4"
        aria-label={[provider.name, account.label].filter(Boolean).join(" ")}
      >
        <header class="flex min-w-0 items-center gap-3">
          <LimitRing
            mark={provider.mark}
            left={limit && left(limit, at)}
            band={limit ? band(limit, at) : "fine"}
            {stale}
            size={34}
          />
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <h2 class="truncate text-section">{provider.name}</h2>
              {#if account.plan}
                <span class="shrink-0 rounded-item bg-active px-1.5 py-0.5 text-label text-muted">
                  {account.plan}
                </span>
              {/if}
              {#if account.readAt !== null}
                <span
                  class="ml-auto shrink-0 pl-2 text-meta text-muted"
                  title="Signed in with {and.format(account.via)} · read {formatDateTime(
                    account.readAt,
                  )}"
                >
                  {`${stale ? "Last read" : "Updated"} ${formatRelative(account.readAt, now())}`}
                </span>
              {/if}
            </div>
            <div class="flex min-w-0 items-center gap-2 text-meta">
              {#if account.label}
                <p class="truncate text-muted">{account.label}</p>
              {/if}
              {#if inUse(account, at)}
                <span class="ml-auto flex shrink-0 items-center gap-1.5 text-(--live)">
                  <span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>
                  In use
                </span>
              {/if}
            </div>
          </div>
        </header>

        {#if account.problem !== null}
          <p class="text-meta text-warning">{explain(account)}</p>
        {/if}

        {#if account.limits.length > 0}
          <ul class={stale ? "opacity-60" : undefined}>
            {#each account.limits as limit, index (index)}
              <LimitRow
                {limit}
                readAt={account.readAt}
                class="grid-cols-[minmax(0,1fr)_auto_auto] [grid-template-areas:'name_when_value'_'bar_bar_bar'] gap-x-3 gap-y-1.5 not-first:pt-3"
              />
            {/each}
          </ul>
        {:else}
          <p class="text-meta text-muted">No limits read yet.</p>
        {/if}
      </section>
    {/each}
  </div>
{/if}
