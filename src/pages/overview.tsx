import { useMemo } from "react";
import { addDays, eachDayOfInterval, startOfDay, subDays } from "date-fns";
import { ArrowDownToLine, ArrowUpRight } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { accountOptions } from "@/lib/queries";
import { forecasts } from "@/lib/usage/forecast";
import { AgentMark } from "@/lib/components/agent-mark";
import { agents, agentIds } from "@/lib/agents";
import type { Session } from "@/lib/bindings";
import type { Model } from "@/lib/models/catalog";
import { activity, aggregate, knownCost, toolStats } from "@/lib/usage/analytics";
import { compact, day, duration, integer, money, relative } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import { offeringProviderNames, usageGroups } from "@/lib/usage/groups";
import { Button } from "@/lib/components/ui/button";
import { UsageOverTime } from "@/lib/components/usage-over-time";
import { ActivityHeatmap } from "@/lib/components/activity-heatmap";
import { RankedList } from "@/lib/components/ranked-list";
import { Metric, PageTitle, Section, Empty } from "@/lib/components/page";
import { SessionTable } from "@/lib/components/session-table";
import { cn } from "cn";

type Props = {
  sessions: Session[];
  allSessions: Session[];
  models: Model[];
  range: number;
  now: number;
  openSession: (id: string) => void;
  openDay: (day: string) => void;
  openTool: (tool: string) => void;
  openModel: (key: string) => void;
  clearScope: () => void;
  navigate: (view: "sessions" | "models" | "connections" | "subscriptions") => void;
};

export default function Overview({
  sessions,
  allSessions,
  models,
  range,
  now,
  openSession,
  openDay,
  openTool,
  openModel,
  navigate,
  clearScope,
}: Props) {
  const start = startOfDay(subDays(now, range - 1)).getTime();
  const accounts = useQuery(accountOptions);
  const quota = useMemo(
    () =>
      forecasts(
        [...(accounts.data?.samples ?? []), ...allSessions.flatMap((session) => session.limits)],
        accounts.data?.accounts ?? [],
        now,
      ),
    [accounts.data, allSessions, now],
  );
  const primaryQuota = agentIds
    .flatMap((agent) => {
      const reading = quota.find((reading) => reading.latest.agent === agent);
      return reading ? [reading] : [];
    })
    .slice(0, 2);
  const end = addDays(startOfDay(now), 1).getTime();
  const stats = useMemo(
    () => aggregate(sessions, models, start, end),
    [sessions, models, start, end],
  );
  const lifetime = useMemo(() => aggregate(sessions, models), [sessions, models]);
  const previousStart = subDays(start, range).getTime();
  const previous = useMemo(
    () => aggregate(sessions, models, previousStart, start),
    [sessions, models, previousStart, start],
  );
  const change = previous.total ? (stats.total / previous.total - 1) * 100 : null;
  const streak = activity(lifetime.days, new Date(now));
  const recent = sessions.filter(
    (session) => session.updatedAt >= start && session.updatedAt < end,
  );
  const usedSessionIds = new Set(stats.sessionIds);
  const projectCount = new Set(
    sessions
      .filter((session) => usedSessionIds.has(session.id))
      .map((session) => session.cwd)
      .filter(Boolean),
  ).size;
  const tools = toolStats(recent);
  const days = eachDayOfInterval({ start, end: now });
  const exportData = useMutation({
    mutationFn: () =>
      exportCsv("overwatch-daily-usage.csv", [
        [
          "Date",
          "Tokens",
          "API equivalent USD",
          "Unpriced tokens",
          "Recorded USD",
          "Estimated USD",
          "Unpriced responses",
          ...agentIds.map((agent) => agents[agent].name),
        ],
        ...days.map((date) => {
          const point = stats.days.get(day(date));
          return [
            day(date),
            point?.total ?? 0,
            point ? knownCost(point) : null,
            point?.unpriced ?? 0,
            point?.recordedCost ?? 0,
            point?.estimatedCost ?? 0,
            point?.unpricedCalls ?? 0,
            ...agentIds.map((agent) => point?.agents[agent] ?? 0),
          ];
        }),
      ]),
  });
  const topModels = useMemo(() => usageGroups(stats.models, "model").slice(0, 5), [stats.models]);
  const cacheInput = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
  return (
    <>
      <PageTitle
        title="Overview"
        action={
          <Button
            variant="outline"
            onClick={() => exportData.mutate()}
            disabled={exportData.isPending || !sessions.length}
          >
            <ArrowDownToLine />
            Export
          </Button>
        }
      />
      {!sessions.length ? (
        <Empty
          title={allSessions.length ? "No sessions match this scope" : "Your workspace starts here"}
          action={
            allSessions.length ? (
              <Button onClick={clearScope}>Clear project and agent filters</Button>
            ) : (
              <Button onClick={() => navigate("connections")}>
                Manage connections
                <ArrowUpRight />
              </Button>
            )
          }
        >
          {allSessions.length
            ? "Your local history is available. Choose another project or agent to see its usage."
            : "Connect your local agent folders to see sessions, token usage, and model insights."}
        </Empty>
      ) : (
        <>
          {stats.undatedCalls > 0 && (
            <p role="status" className="mb-6 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
              {integer(stats.undatedCalls)} {stats.undatedCalls === 1 ? "response" : "responses"} (
              {compact(stats.undatedTokens)} tokens) {stats.undatedCalls === 1 ? "has" : "have"} no
              usable timestamp. This usage remains in whole-session totals and is excluded from date
              ranges, charts, and activity streaks.{" "}
              <button
                className="rounded underline underline-offset-4"
                onClick={() => navigate("sessions")}
              >
                Review sessions
              </button>
            </p>
          )}
          {stats.calls === 0 && (
            <p role="status" className="mb-6 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
              No model responses recorded in this period. Choose a longer date range to look back
              further.
            </p>
          )}
          <div className="mb-10 grid grid-cols-2 gap-6 xl:grid-cols-4">
            <Metric
              label="Total tokens"
              value={compact(stats.total)}
              detail={
                change == null
                  ? `${integer(stats.calls)} recorded model responses`
                  : `${change >= 0 ? "+" : ""}${change.toFixed(1)}% vs. previous ${range} days`
              }
            />
            <Metric
              label="API equivalent"
              value={money(knownCost(stats))}
              detail={
                stats.unpricedCalls > 0
                  ? `${integer(stats.unpricedCalls)} responses unpriced · known subtotal`
                  : `${money(stats.recordedCost)} recorded · ${money(stats.estimatedCost)} estimated`
              }
            />
            <Metric
              label="Sessions with usage"
              value={integer(stats.sessionIds.length)}
              detail={`${projectCount} ${projectCount === 1 ? "project" : "projects"} with recorded responses`}
            />
            <Metric
              label="Cache hit rate"
              value={
                cacheInput ? `${((stats.tokens.cacheRead / cacheInput) * 100).toFixed(1)}%` : "—"
              }
              detail={`${compact(stats.tokens.cacheRead)} cached input tokens`}
            />
          </div>
          <div
            className={cn(
              "grid gap-8",
              primaryQuota.length > 0 && "grid-cols-[minmax(0,1fr)_230px] max-[1100px]:grid-cols-1",
            )}
          >
            <UsageOverTime stats={stats} start={start} now={now} range={range} />
            {primaryQuota.length > 0 && (
              <Section
                title="Subscriptions"
                className="self-start rounded-xl bg-card p-5"
                action={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="View subscriptions"
                    onClick={() => navigate("subscriptions")}
                  >
                    <ArrowUpRight />
                  </Button>
                }
              >
                <div className="space-y-7">
                  {primaryQuota.map(({ latest, state, exhaustionAt }) => (
                    <button
                      key={latest.agent}
                      onClick={() => navigate("subscriptions")}
                      className="block w-full text-left"
                    >
                      <span className="flex items-center gap-2 text-xs">
                        <AgentMark agent={latest.agent} className="size-5" />
                        {agents[latest.agent].name}
                      </span>
                      <span className="mt-4 block text-2xl tabular-nums">
                        {state === "expired" ? "—" : `${Math.round(100 - latest.usedPercent)}%`}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {state === "expired" ? "window ended" : "remaining"}
                        </span>
                      </span>
                      <span className="mt-3 block h-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${100 - latest.usedPercent}%` }}
                        />
                      </span>
                      <span className="mt-3 block text-xs leading-relaxed text-muted-foreground">
                        {latest.label} ·{" "}
                        {state === "stale" || state === "expired"
                          ? `Last read ${relative(latest.timestamp)}`
                          : exhaustionAt == null
                            ? "Collecting pace samples"
                            : exhaustionAt > (latest.resetsAt ?? Infinity)
                              ? "Resets before projected limit"
                              : `${duration(Math.max(0, exhaustionAt - now))} at this pace`}
                      </span>
                    </button>
                  ))}
                </div>
              </Section>
            )}
          </div>
          <div className="my-10 grid grid-cols-[minmax(0,1fr)_220px] gap-10 max-[1100px]:grid-cols-1">
            <ActivityHeatmap lifetime={lifetime} sessions={sessions} now={now} openDay={openDay} />
            <div className="grid grid-cols-2 gap-x-5 gap-y-7 self-center">
              <div>
                <p className="text-2xl font-medium tabular-nums">
                  {streak.current}
                  <span className="ml-1 text-xs text-muted-foreground">days</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Current streak</p>
              </div>
              <div>
                <p className="text-2xl font-medium tabular-nums">
                  {streak.longest}
                  <span className="ml-1 text-xs text-muted-foreground">days</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Longest streak</p>
              </div>
              <div>
                <p className="text-xl tabular-nums">{streak.activeDays}</p>
                <p className="mt-1 text-xs text-muted-foreground">Active days · lifetime</p>
              </div>
              <div>
                <p className="text-xl tabular-nums">{compact(streak.peak?.total ?? 0)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Peak · {streak.peak?.day ?? "—"}
                </p>
              </div>
            </div>
          </div>
          <div className="mb-10 grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-12">
            <Section
              title="Most used models"
              action={
                <Button variant="ghost" size="xs" onClick={() => navigate("models")}>
                  Explore
                  <ArrowUpRight />
                </Button>
              }
            >
              <RankedList
                items={topModels}
                itemKey={(model) => model.key}
                value={(model) => model.tokens}
                color={(model) => model.color}
                formatValue={(model) => compact(model.tokens)}
                title={(model) => `${model.label} · ${offeringProviderNames(model).join(", ")}`}
                ariaLabel={(model) => `View ${model.label} usage`}
                onSelect={(model) => openModel(model.key)}
                label={(model) => (
                  <>
                    {model.label}
                    <span className="ml-2 text-muted-foreground">
                      {offeringProviderNames(model).join(", ")}
                    </span>
                  </>
                )}
              />
            </Section>
            <Section title="Tool activity">
              <RankedList
                items={tools.slice(0, 5)}
                itemKey={(tool) => tool.name}
                value={(tool) => tool.calls}
                formatValue={(tool) => integer(tool.calls)}
                title={(tool) => tool.name}
                ariaLabel={(tool) => `Find ${tool.name} in sessions`}
                onSelect={(tool) => openTool(tool.name)}
                labelClassName="truncate rounded text-left font-mono hover:text-primary hover:underline"
                label={(tool) => tool.name}
              />
            </Section>
          </div>
          <Section
            title="Recent sessions"
            action={
              <Button variant="ghost" size="xs" onClick={() => navigate("sessions")}>
                All sessions
                <ArrowUpRight />
              </Button>
            }
          >
            <SessionTable sessions={recent.slice(0, 5)} boxed={false} onOpen={openSession} />
          </Section>
          <p className="mt-8 text-xs leading-relaxed text-muted-foreground">
            API equivalent is a model-price estimate, not your subscription bill. Usage follows each
            recorded event’s date; tool activity includes complete sessions updated in this period.
          </p>
        </>
      )}
    </>
  );
}
