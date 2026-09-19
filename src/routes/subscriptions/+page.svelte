<script lang="ts">
  /**
   * How much of each subscription's usage limits is left, the account nearest
   * to stopping work first. The engine announces every account it reads, so
   * this only presents them; one whose read failed keeps its last limits and
   * says why.
   */
  import CreditCard from "@lucide/svelte/icons/credit-card";
  import Empty from "#lib/components/ui/Empty.svelte";
  import PageHeader, { pageIcon } from "#lib/components/ui/PageHeader.svelte";
  import Mark from "#lib/components/marks/Mark.svelte";
  import LimitRow from "#lib/components/limits/LimitRow.svelte";
  import { PROVIDERS, byUrgency, explain, inUse } from "#lib/limits.ts";
  import { now } from "#lib/state/clock.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { formatDateTime, formatRelative } from "#lib/format.ts";

  const engine = getEngine();

  const and = new Intl.ListFormat("en", { type: "conjunction" });

  const at = $derived(now().getTime());
  const accounts = $derived(byUrgency(engine.status.accounts, at));

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
  <div class="grid gap-8">
    {#each accounts as account (account.id)}
      {@const provider = PROVIDERS[account.provider]}
      <section aria-label={[provider.name, account.label].filter(Boolean).join(" ")}>
        <div class="flex min-w-0 items-center gap-2">
          <Mark name={provider.mark} size={16} class="shrink-0 text-muted" />
          <h2 class="text-section">{provider.name}</h2>
          {#if account.plan}
            <span class="rounded-item bg-active px-1.5 py-0.5 text-label text-muted">
              {account.plan}
            </span>
          {/if}
          {#if account.label}
            <span class="min-w-0 truncate text-meta text-muted">{account.label}</span>
          {/if}
          <span class="ml-auto flex shrink-0 gap-3 text-meta text-muted">
            {#if inUse(account, at)}
              <span class="text-(--live)">In use</span>
            {/if}
            {#if account.readAt !== null}
              <span
                title="Signed in with {and.format(account.via)} · read {formatDateTime(
                  account.readAt,
                )}"
              >
                Updated {formatRelative(account.readAt, now())}
              </span>
            {/if}
          </span>
        </div>

        {#if account.problem !== null}
          <p class="mt-1 text-meta text-warning">{explain(account)}</p>
        {/if}

        {#if account.limits.length > 0}
          <ul class="mt-2">
            {#each account.limits as limit, index (index)}
              <LimitRow
                {limit}
                class="grid-cols-[minmax(0,12rem)_minmax(3rem,1fr)_6.5rem_minmax(0,12rem)] [grid-template-areas:'name_bar_value_when'] gap-4 py-1.5"
              />
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>
{/if}
