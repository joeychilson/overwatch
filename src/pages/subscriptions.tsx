import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { agents } from "@/lib/agents";
import { commands, type Agent } from "@/lib/bindings";
import { AppFailure, native } from "@/lib/errors";
import { subscriptionForecasts } from "@/lib/usage/forecast";
import { logAllowanceOptions } from "@/lib/history";
import { accountOptions } from "@/lib/queries";
import { money, relative } from "@/lib/format";
import { cn } from "cn";
import { Button } from "@/lib/components/ui/button";
import { AllowancesSkeleton } from "@/lib/components/page-skeleton";
import { Allowance, UsageHistory } from "@/lib/components/subscription-usage";
import { TokenForm } from "@/lib/components/token-form";
import { AgentMark } from "@/lib/components/agent-mark";
import { Empty, ErrorNotice, Modal, PageHeader } from "@/lib/components/page";

const providers: Agent[] = ["codex", "claude", "opencode", "grok", "antigravity"];
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
      <PageHeader
        icon={<CreditCard />}
        title="Subscriptions"
        description="Track usage and limits across your AI subscriptions."
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
