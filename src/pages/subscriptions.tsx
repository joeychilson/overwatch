import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceStrict, isSameDay } from "date-fns";
import { KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { Line, LineChart, XAxis, YAxis, CartesianGrid, ReferenceLine, Tooltip } from "recharts";
import { toast } from "sonner";
import { agents } from "@/lib/agents";
import { commands, type Agent } from "@/lib/bindings";
import { AppFailure, failure, native } from "@/lib/errors";
import {
  subscriptionForecasts,
  reachesLimitBeforeReset,
  type Forecast,
} from "@/lib/usage/forecast";
import { logAllowanceOptions } from "@/lib/history";
import { accountOptions } from "@/lib/queries";
import { money, relative } from "@/lib/format";
import { cn } from "cn";
import { Button } from "@/lib/components/ui/button";
import { Input } from "@/lib/components/ui/input";
import { AllowancesSkeleton } from "@/lib/components/page-skeleton";
import { ChartContainer, ChartHoverCard } from "@/lib/components/ui/chart";
import { AgentMark } from "@/lib/components/agent-mark";
import { Empty, ErrorNotice, Modal, PageTitle } from "@/lib/components/page";

const providers: Agent[] = ["codex", "claude", "opencode", "grok", "antigravity"];
function TokenForm({ agent, close }: { agent: Agent; close: () => void }) {
  const client = useQueryClient();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const credential = token;
    setToken("");
    setBusy(true);
    setError(null);
    try {
      await native(commands.saveToken(agent, credential));
      const status = await native(commands.refreshAccount(agent));
      await client.invalidateQueries(accountOptions);
      if (status.error) throw new AppFailure(status.error);
      close();
      toast.success("Account connected");
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Use a provider access token{agent === "opencode" ? " or OpenCode Go API key" : ""}.
        Overwatch stores it in your OS credential store. Existing provider sign-in files remain read
        only.
      </p>
      {error && <ErrorNotice error={error} />}
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label="Provider access token"
        placeholder="Access token"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        disabled={busy}
      />
      <Button type="submit" disabled={busy || !token.trim()}>
        {busy ? "Connecting…" : "Save and connect"}
      </Button>
    </form>
  );
}
export default function Subscriptions({ now }: { now: number }) {
  const logs = useQuery(logAllowanceOptions);
  const client = useQueryClient();
  const [agent, setAgent] = useState<Agent>("codex");
  const [connect, setConnect] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [historyBucket, setHistoryBucket] = useState<string | null>(null);
  const query = useQuery(accountOptions);
  const refresh = useMutation({
    mutationFn: (agent: Agent) => native(commands.refreshAccount(agent)),
    onSuccess: () => client.invalidateQueries(accountOptions),
  });
  const remove = useMutation({
    mutationFn: () => native(commands.saveToken(agent, null)),
    onSuccess: async () => {
      await client.invalidateQueries(accountOptions);
      setRemoveOpen(false);
      toast.success("Saved connection data removed");
    },
  });
  const all = useMemo(
    () => subscriptionForecasts(query.data, [{ limits: logs.data ?? [] }], now),
    [query.data, logs.data, now],
  );
  const windows = all.filter((forecast) => forecast.latest.agent === agent);
  const history = windows.find((window) => window.latest.bucket === historyBucket) ?? windows[0];
  const account = query.data?.accounts.find((account) => account.agent === agent);
  const usage = account?.usage;
  const busy = refresh.isPending || remove.isPending;
  return (
    <>
      <PageTitle
        title="Subscriptions"
        action={
          <Button variant="outline" disabled={busy} onClick={() => refresh.mutate(agent)}>
            <RefreshCw className={refresh.isPending ? "animate-spin" : ""} />
            Refresh usage
          </Button>
        }
      />
      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Subscription provider">
        {providers.map((provider) => (
          <Button
            key={provider}
            variant={provider === agent ? "secondary" : "ghost"}
            aria-pressed={provider === agent}
            onClick={() => {
              setAgent(provider);
              setHistoryBucket(null);
            }}
          >
            <AgentMark agent={provider} className="size-6 bg-transparent [&>img]:size-5" />
            {agents[provider].name}
          </Button>
        ))}
      </div>
      {logs.error && <ErrorNotice error={logs.error} retry={() => void logs.refetch()} />}
      {query.error && <ErrorNotice error={query.error} retry={() => void query.refetch()} />}
      {account?.error && (
        <>
          <ErrorNotice error={new AppFailure(account.error)} />
          {usage && (
            <p className="mb-5 text-xs text-muted-foreground">
              Showing the last successful reading from {relative(usage.updatedAt)}.
            </p>
          )}
        </>
      )}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <AgentMark agent={agent} className="size-10" />
          <div>
            <h2 className="text-lg font-medium">
              {agents[agent].name}
              {usage?.plan && (
                <span className="ml-3 rounded-md bg-muted px-2 py-1 text-[11px] font-normal text-muted-foreground capitalize">
                  {usage.plan}
                </span>
              )}
            </h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {usage
                ? `${usage.source} · ${relative(usage.updatedAt)}`
                : windows.length
                  ? "Quota readings from local session logs"
                  : "Account-wide subscription usage"}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setConnect(true)}>
            <KeyRound />
            Connect with token
          </Button>
          {account && (
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label="Remove saved connection data"
              title="Remove saved connection data"
              onClick={() => setRemoveOpen(true)}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>
      {query.isPending && !windows.length ? (
        <AllowancesSkeleton />
      ) : !windows.length && !usage?.balances.length ? (
        <Empty
          title={usage ? "No allowance readings" : "Connect your subscription"}
          action={
            <Button disabled={busy} onClick={() => refresh.mutate(agent)}>
              {usage ? "Refresh usage" : "Use existing sign-in"}
            </Button>
          }
        >
          {usage ? (
            "Refresh to read your current subscription allowances."
          ) : (
            <>
              Overwatch can read {agents[agent].name} usage from an existing sign-in
              {agent === "antigravity" ? " with a Google access token" : " or a saved access token"}
              . Your subscription allowance comes directly from the provider.
            </>
          )}
        </Empty>
      ) : (
        <>
          <div
            className={cn(
              "grid items-start gap-4",
              windows.length > 1 && "min-[1100px]:grid-cols-2",
            )}
          >
            {windows.map((forecast) => (
              <Allowance key={forecast.latest.bucket} forecast={forecast} now={now} />
            ))}
          </div>
          {history && (
            <section className="mt-5 rounded-xl bg-card p-5" aria-label="Allowance history">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-medium">Usage history</h3>
                {windows.length > 1 && (
                  <div className="flex flex-wrap gap-1" role="group" aria-label="History window">
                    {windows.map(({ latest }) => (
                      <Button
                        key={latest.bucket}
                        size="sm"
                        variant={history.latest.bucket === latest.bucket ? "secondary" : "ghost"}
                        aria-pressed={history.latest.bucket === latest.bucket}
                        onClick={() => setHistoryBucket(latest.bucket)}
                      >
                        {latest.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              <UsageHistory forecast={history} />
            </section>
          )}
          {!!usage?.balances.length && (
            <div className="mt-4 space-y-3">
              {usage.balances.map((balance) => {
                const amount = (value: number | null) =>
                  value == null
                    ? "—"
                    : balance.unit === "USD"
                      ? money(value)
                      : `${value.toLocaleString()} ${balance.unit}`;
                return (
                  <section
                    key={balance.label}
                    className="flex items-center justify-between gap-5 rounded-xl bg-card px-5 py-4"
                  >
                    <div>
                      <h3 className="text-sm font-medium">{balance.label}</h3>
                      {!balance.unlimited && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {balance.remaining != null ? "Remaining" : "Used"}
                          {balance.limit != null ? ` · ${amount(balance.limit)} allowance` : ""}
                          {balance.used != null && balance.remaining != null
                            ? ` · ${amount(balance.used)} used`
                            : ""}
                        </p>
                      )}
                    </div>
                    <p className="text-xl tabular-nums">
                      {balance.unlimited ? "Unlimited" : amount(balance.remaining ?? balance.used)}
                    </p>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
      <p className="mt-8 text-[11px] leading-relaxed text-muted-foreground">
        Connected accounts refresh every five minutes. Pace estimates use recent readings from the
        same account and reset window. Project filters do not change account allowances.
      </p>
      <Modal
        open={connect}
        onOpenChange={setConnect}
        title={`Connect ${agents[agent].name}`}
        description="Secure provider credentials"
      >
        {connect && <TokenForm key={agent} agent={agent} close={() => setConnect(false)} />}
      </Modal>
      <Modal
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={`Remove ${agents[agent].name} connection data?`}
        description="This action cannot be undone."
      >
        <p className="text-sm leading-relaxed text-muted-foreground">
          Overwatch will forget any access token it saved for this provider and delete its local
          allowance history. Provider sign-in files are not changed, so using the existing sign-in
          later may connect the account again.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={remove.isPending} onClick={() => setRemoveOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? "Removing…" : "Remove data"}
          </Button>
        </div>
      </Modal>
    </>
  );
}

function Allowance({ forecast, now }: { forecast: Forecast; now: number }) {
  const { latest, state } = forecast;
  const expired = state === "expired";
  const stale = state === "stale";
  const remaining = Math.max(0, 100 - latest.usedPercent);
  const runsOut = reachesLimitBeforeReset(forecast);
  const pace = expired
    ? "Refresh to read the new allowance window."
    : stale
      ? "Refresh usage for a current pace estimate."
      : remaining <= 0
        ? "Allowance used up."
        : runsOut && forecast.exhaustionAt != null
          ? forecast.exhaustionAt <= now
            ? "May already be used up at the recent pace."
            : `May run out ${formatDistanceStrict(forecast.exhaustionAt, now, { addSuffix: true })} at this pace.`
          : state === "projected" && forecast.atReset != null
            ? `About ${(100 - forecast.atReset).toFixed(0)}% left at reset at this pace.`
            : state === "steady"
              ? "No increase in recent readings."
              : "Pace estimate needs more readings.";
  return (
    <section className="rounded-xl bg-card p-5" aria-label={`${latest.label} allowance`}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{latest.label}</h3>
        {(expired || stale) && (
          <span className="text-xs text-warning">
            {expired ? "Window ended" : "Refresh needed"}
          </span>
        )}
      </div>
      <div className="mt-5 flex items-end justify-between gap-4">
        <p className="text-4xl leading-none tracking-tight tabular-nums">
          {expired ? "—" : remaining.toFixed(0)}
          {!expired && <span className="ml-1 text-lg text-muted-foreground">%</span>}
          <span className="ml-2 text-xs tracking-normal text-muted-foreground">
            {expired ? "ended" : "left"}
          </span>
        </p>
        <span className="text-xs text-muted-foreground tabular-nums">
          {latest.usedPercent.toFixed(0)}% used
        </span>
      </div>
      <div
        className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={`${latest.label} quota remaining`}
        aria-valuenow={remaining}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-full rounded-full bg-primary", remaining <= 10 && "bg-warning")}
          style={{ width: `${remaining}%` }}
        />
      </div>
      <p
        className={cn(
          "mt-4 text-xs leading-relaxed text-muted-foreground",
          runsOut && "text-warning",
        )}
        title={
          state === "collecting"
            ? "At least three readings over 15 minutes are needed to estimate pace."
            : undefined
        }
      >
        {pace}
      </p>
      <div className="mt-5 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          {latest.resetsAt
            ? `${expired ? "Ended" : "Resets"} ${formatDistanceStrict(latest.resetsAt, now, { addSuffix: true })}`
            : "Reset time unavailable"}
        </span>
        {latest.resetsAt && (
          <time dateTime={new Date(latest.resetsAt).toISOString()}>
            {format(latest.resetsAt, "MMM d, HH:mm")}
          </time>
        )}
      </div>
    </section>
  );
}

function UsageHistory({ forecast }: { forecast: Forecast }) {
  const { latest, samples } = forecast;
  return (
    <>
      {samples.length > 1 ? (
        <ChartContainer
          className="aspect-auto h-40 w-full"
          aria-label={`${latest.label} usage history`}
        >
          <LineChart data={samples} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(time: number) => format(time, "HH:mm")}
              axisLine={false}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 50, 100]}
              tickFormatter={(value: number) => `${value}%`}
              width={38}
              axisLine={false}
              tickLine={false}
            />
            <ReferenceLine y={100} stroke="var(--border)" strokeDasharray="3 3" />
            <Tooltip
              content={({ active, payload }) => {
                const value = payload?.[0]?.value;
                if (!active || typeof value !== "number") return null;
                return (
                  <ChartHoverCard>
                    <div className="font-medium">Recorded usage</div>
                    <div className="grid gap-1.5">
                      <div className="flex w-full flex-wrap items-center gap-2">
                        <span className="font-mono tabular-nums">{value.toFixed(1)}% used</span>
                      </div>
                    </div>
                  </ChartHoverCard>
                );
              }}
            />
            <Line
              dataKey="usedPercent"
              stroke="var(--chart-1)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      ) : (
        <p className="py-5 text-sm text-muted-foreground">
          The history chart will appear after another usage reading.
        </p>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground">
        {format(samples[0].timestamp, "MMM d, HH:mm")}
        {samples.length > 1 &&
          `–${format(latest.timestamp, isSameDay(samples[0].timestamp, latest.timestamp) ? "HH:mm" : "MMM d, HH:mm")}`}
      </p>
    </>
  );
}
