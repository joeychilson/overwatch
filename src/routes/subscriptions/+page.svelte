<script lang="ts">
  /**
   * How much of each subscription's usage limits is left.
   *
   * The engine reads every account it finds a sign-in to, whichever app holds
   * it, and announces the result with its status, so this page only presents
   * what it is given. A read that fails leaves the last limits on screen with
   * the reason, because a stale figure passed off as current would be worse
   * than none.
   *
   * Each limit is one row — what is left, and when that changes — so every
   * account fits in view together, the one nearest to stopping work first.
   */
  import CreditCard from "@lucide/svelte/icons/credit-card";
  import PageHeader, { pageIcon } from "#lib/components/ui/PageHeader.svelte";
  import Mark from "#lib/components/marks/Mark.svelte";
  import LimitRow from "#lib/components/limits/LimitRow.svelte";
  import { PROVIDERS, byUrgency, explain, inUse } from "#lib/limits.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { getClock } from "#lib/state/clock.svelte.ts";
  import { formatDateTime, formatRelative } from "#lib/format.ts";

  const engine = getEngine();
  const clock = getClock();

  const and = new Intl.ListFormat("en", { type: "conjunction" });

  const now = $derived(clock.now.getTime());
  const accounts = $derived(byUrgency(engine.status.accounts, now));

  /** How many accounts there are and how many are in use, such as `3 accounts · 1 in use`. */
  const summary = $derived.by(() => {
    if (accounts.length === 0) return undefined;
    const counted = `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`;
    const using = accounts.filter((account) => inUse(account, now)).length;
    return using === 0 ? counted : `${counted} · ${using} in use`;
  });
</script>

<svelte:head><title>Subscriptions · Overwatch</title></svelte:head>

<PageHeader title="Subscriptions" description={summary}>
  {#snippet icon()}<CreditCard {...pageIcon} />{/snippet}
</PageHeader>

{#if accounts.length === 0}
  <div class="grid justify-items-start gap-2">
    <p>No subscriptions found.</p>
    <p class="max-w-prose text-muted">
      Overwatch reads Codex, Claude, Grok and OpenCode Go limits with the sign-ins that Codex,
      Claude Code, Grok Build, OpenCode and Pi keep on this Mac. Sign in to a subscription in any of
      them and its limits appear here.
    </p>
  </div>
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
            {#if inUse(account, now)}
              <span class="text-(--live)">In use</span>
            {/if}
            {#if account.readAt !== null}
              <span
                title="Signed in with {and.format(account.via)} · read {formatDateTime(
                  account.readAt,
                )}"
              >
                Updated {formatRelative(account.readAt, clock.now)}
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
                now={clock.now}
                class="grid-cols-[minmax(0,12rem)_minmax(3rem,1fr)_6.5rem_minmax(0,12rem)] [grid-template-areas:'name_bar_value_when'] gap-4 py-1.5"
              />
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>
{/if}
