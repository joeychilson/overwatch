/**
 * How close subscription limits are to stopping work.
 *
 * The Subscriptions page and the menu bar item's panel order, group and colour
 * accounts by this, and the sidebar marks the page with it, so all three agree.
 * Both put first the accounts the menu bar's figure follows, by the engine's
 * rule.
 */
import type { Account, Limit, Provider } from "./api/backend.ts";
import type { MarkName } from "./components/marks/marks.ts";

/** How each subscription is named and marked. */
export const PROVIDERS: Record<Provider, { name: string; mark: MarkName }> = {
  claude: { name: "Claude", mark: "anthropic" },
  codex: { name: "Codex", mark: "openai" },
  grok: { name: "Grok", mark: "xai" },
  open_code_go: { name: "OpenCode Go", mark: "opencode" },
};

/** How recently a subscription must have been used to count as in use, as the engine counts it. */
const IN_USE = 30 * 60_000;

/** Whether an account has been used in the last half hour, from anywhere. */
export function inUse(account: Account, now: number): boolean {
  return account.usedAt !== null && now - account.usedAt <= IN_USE;
}

const or = new Intl.ListFormat("en", { type: "disjunction" });

/** Why an account's limits were not refreshed, and what fixes it. */
export function explain(account: Account): string {
  const name = PROVIDERS[account.provider].name;
  switch (account.problem) {
    case "sign_in":
      return `Open ${or.format(account.via)} to renew the sign-in.`;
    case "unavailable":
      return `Couldn't reach ${name}. Trying again in a few minutes.`;
    case "unrecognized":
      return `${name}'s response has changed, so these limits couldn't be read.`;
    case null:
      return "";
  }
}

/**
 * How close a limit is to stopping work.
 *
 * Bands rather than exact percentages, so an account moves only when something
 * changes for the reader, not every time a number ticks up.
 */
export type Band = "blocked" | "out" | "low" | "fine";

const RANK: Record<Band, number> = { blocked: 0, out: 1, low: 2, fine: 3 };

/** Whether a limit's window has ended since it was read, refilling it. */
export function ended(limit: Limit, now: number): boolean {
  return limit.resetsAt !== null && limit.resetsAt <= now;
}

/** How much of a limit is left, from 0 to 100; one whose window has ended is full again. */
export function left(limit: Limit, now: number): number {
  return ended(limit, now) ? 100 : Math.max(0, 100 - limit.usedPercent);
}

/**
 * How much of a window must have passed before its average pace says where it
 * is heading: early on, a few minutes' use would read as a flood.
 */
const SETTLED = 0.05;

/** How much of a limit's window has passed, from 0 to 1, while it is running. */
function elapsed(limit: Limit, now: number): number | null {
  if (limit.startsAt === null || limit.resetsAt === null || ended(limit, now)) return null;
  const length = limit.resetsAt - limit.startsAt;
  if (length <= 0) return null;
  return Math.min(1, Math.max(0, (now - limit.startsAt) / length));
}

/**
 * How much of a limit's window is still to come, from 0 to 100, set beside
 * how much of the limit is left; null when the provider does not say when the
 * window began, or once it has ended.
 */
export function timeLeft(limit: Limit, now: number): number | null {
  const passed = elapsed(limit, now);
  return passed === null ? null : (1 - passed) * 100;
}

/**
 * How much of a limit will have been used by its reset if the rest of the
 * window goes as it has so far, from 0; above 100 means it runs out first.
 * Null until enough of the window has passed to say.
 */
export function onTrackFor(limit: Limit, now: number): number | null {
  const passed = elapsed(limit, now);
  return passed === null || passed < SETTLED ? null : limit.usedPercent / passed;
}

/** When a limit runs out at the recent rate of use, while that is still ahead. */
export function runsOut(limit: Limit, now: number): number | null {
  return limit.runsOutAt !== null && limit.runsOutAt > now && !ended(limit, now)
    ? limit.runsOutAt
    : null;
}

/** The band a limit is in now. */
export function band(limit: Limit, now: number): Band {
  const remaining = left(limit, now);
  if (remaining <= 0) return "blocked";
  if (remaining <= 10) return "out";
  // A limit on pace to run out before it resets is running low, whatever is left.
  if (remaining <= 30 || runsOut(limit, now) !== null) return "low";
  return "fine";
}

/**
 * The limit on all usage with the least left, which stops work first; null
 * when an account has none. The first of equals is kept.
 */
export function tightest(account: Account, now: number): Limit | null {
  let found: Limit | null = null;
  for (const limit of account.limits) {
    if (limit.scope === null && (found === null || left(limit, now) < left(found, now))) {
      found = limit;
    }
  }
  return found;
}

/**
 * The accounts the menu bar's figure is drawn from, as the engine picks them:
 * those in use, or else those used last, or else every account.
 */
export function followed(accounts: readonly Account[], now: number): Account[] {
  const used = accounts.flatMap((account) => (account.usedAt === null ? [] : [account.usedAt]));
  if (used.length === 0) return [...accounts];
  const since = Math.min(Math.max(...used), now - IN_USE);
  return accounts.filter((account) => account.usedAt !== null && account.usedAt >= since);
}

/** A run of accounts, under a label only when some are in use and others are not. */
export interface Group {
  label: "In use" | "Not in use" | null;
  accounts: Account[];
}

/**
 * Accounts as the menu bar panel and the Subscriptions page show them.
 *
 * Those the menu bar's figure follows come first: the accounts in use, set
 * apart by name from the rest, or else the one used last, simply put first.
 * Each run goes nearest to stopping work first, and an account with no limit
 * read yet, which has nothing to show, goes last.
 */
export function arrange(accounts: readonly Account[], now: number): Group[] {
  const ordered = byUrgency(accounts, now).sort(
    (a, b) => Number(a.limits.length === 0) - Number(b.limits.length === 0),
  );
  const first = followed(ordered, now);
  const rest = ordered.filter((account) => !first.includes(account));
  const groups: Group[] = first.some((account) => inUse(account, now))
    ? [
        { label: "In use", accounts: first },
        { label: "Not in use", accounts: rest },
      ]
    : [{ label: null, accounts: [...first, ...rest] }];
  return groups.filter((group) => group.accounts.length > 0);
}

/**
 * Accounts with the one nearest to stopping work first.
 *
 * An account ranks by its tightest limit on all usage: using up one model's
 * limit does not stop work with the others. The sort is stable, so accounts in
 * the same band keep the engine's order.
 */
export function byUrgency(accounts: readonly Account[], now: number): Account[] {
  const rank = (account: Account) =>
    Math.min(
      RANK.fine,
      ...account.limits
        .filter((limit) => limit.scope === null)
        .map((limit) => RANK[band(limit, now)]),
    );
  return [...accounts].sort((a, b) => rank(a) - rank(b));
}

/** Whether any limit on all usage is used up, or else on pace to run out. */
export function attention(
  accounts: readonly Account[],
  now: number,
): "blocked" | "running_out" | null {
  const limits = accounts.flatMap((account) =>
    account.limits.filter((limit) => limit.scope === null),
  );
  if (limits.some((limit) => band(limit, now) === "blocked")) return "blocked";
  if (limits.some((limit) => runsOut(limit, now) !== null)) return "running_out";
  return null;
}
