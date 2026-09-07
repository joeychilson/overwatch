import { useMemo } from "react";
import { addDays, eachDayOfInterval, formatDistanceStrict, startOfDay, subDays } from "date-fns";
import { ChartNoAxesCombined, ArrowDownToLine, ArrowUpRight, TriangleAlert } from "lucide-react";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { accountOptions } from "@/lib/queries";
import { subscriptionForecasts, subscriptionWarnings } from "@/lib/usage/forecast";
import { agents, agentIds } from "@/lib/agents";
import {
  historyScope,
  sessionOptions,
  sessionQuery,
  toolOptions,
  useUsage,
  logAllowanceOptions,
} from "@/lib/history";
import type { HistoryScope } from "@/lib/bindings";
import { activity } from "@/lib/usage/analytics";
import { knownCost } from "@/lib/usage/costs";
import { compact, day, integer, money } from "@/lib/format";
import { exportCsv, confirmExport } from "@/lib/export";
import { offeringProviderNames, usageGroups } from "@/lib/usage/groups";
import { Button } from "@/lib/components/ui/button";
import { UsageOverTime } from "@/lib/components/usage-over-time";
import { ActivityHeatmap } from "@/lib/components/activity-heatmap";
import { RankedList } from "@/lib/components/ranked-list";
import { Metric, PageHeader, Section, Empty } from "@/lib/components/page";
import { SessionTable } from "@/lib/components/session-table";

type Props = {
  scope: HistoryScope;
  sessionCount: number;
  scanning: boolean;
  detectedSources: number;
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
  scope,
  sessionCount,
  scanning,
  detectedSources,
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
  const logs = useQuery(logAllowanceOptions);
  const quota = useMemo(
    () => subscriptionForecasts(accounts.data, [{ limits: logs.data ?? [] }], now),
    [accounts.data, logs.data, now],
  );
  const warnings = subscriptionWarnings(quota, now);
  const end = addDays(startOfDay(now), 1).getTime();
  const { stats } = useUsage(historyScope({ ...scope, start, end }));
  const { stats: lifetime } = useUsage(scope);
  const previousStart = subDays(start, range).getTime();
  const { stats: previous } = useUsage(
    historyScope({ ...scope, start: previousStart, end: start }),
  );
  const change = previous.total ? (stats.total / previous.total - 1) * 100 : null;
  const streak = activity(lifetime.days, new Date(now));
  const recent = useSuspenseQuery(
    sessionOptions(sessionQuery(scope, { activityAfter: start, activityBefore: end, limit: 5 })),
  ).data;
  const scopedSessions = useSuspenseQuery(sessionOptions(sessionQuery(scope, { limit: 1 }))).data
    .total;
  const projectCount = stats.projectCount;
  const { data: tools } = useSuspenseQuery(toolOptions(historyScope({ ...scope, start, end })));
  const days = eachDayOfInterval({ start, end: now });
  const exportData = useMutation({
    onSuccess: confirmExport,
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
      <PageHeader
        icon={<ChartNoAxesCombined />}
        title="Overview"
        description="Activity, tokens, and costs across your coding agents."
        action={
          <Button
            variant="outline"
            onClick={() => exportData.mutate()}
            disabled={exportData.isPending || !scopedSessions}
          >
            <ArrowDownToLine />
            Export
          </Button>
        }
      />
      {warnings.length > 0 && (
        <div
          role="status"
          aria-label="Subscription warnings"
          className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-warning/20 bg-warning/5 px-4 py-3"
        >
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="space-y-2">
              {warnings.map(({ latest, exhaustionAt }) => (
                <div key={latest.agent} className="text-xs leading-relaxed">
                  <p>
                    <span className="font-medium">
                      {agents[latest.agent].name} · {latest.label}
                    </span>
                    <span className="text-warning">
                      {" — "}
                      {latest.usedPercent >= 100
                        ? "Limit reached"
                        : exhaustionAt != null && exhaustionAt <= now
                          ? "May already be at the limit"
                          : `May reach limit in ${formatDistanceStrict(exhaustionAt!, now)} at this pace`}
                    </span>
                  </p>
                  <p className="text-muted-foreground">
                    {Math.round(Math.max(0, Math.min(100, 100 - latest.usedPercent)))}% remaining
                    {latest.resetsAt != null
                      ? ` · Resets in ${formatDistanceStrict(latest.resetsAt, now)}`
                      : " · Reset time unavailable"}
                  </p>
                </div>
              ))}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate("subscriptions")}>
            View subscriptions <ArrowUpRight />
          </Button>
        </div>
      )}
      {!scopedSessions ? (
        <Empty
          title={
            scanning
              ? "Reading local history…"
              : sessionCount
                ? "No sessions match this scope"
                : "Your workspace starts here"
          }
          action={
            sessionCount && !scanning ? (
              <Button onClick={clearScope}>Clear project and agent filters</Button>
            ) : (
              <Button onClick={() => navigate("connections")}>
                Manage connections
                <ArrowUpRight />
              </Button>
            )
          }
        >
          {scanning ? (
            <span role="status">
              {integer(sessionCount)} sessions indexed so far. You can keep using Overwatch while it
              reads your folders.
            </span>
          ) : sessionCount ? (
            "Your local history is available. Choose another project or agent to see its usage."
          ) : (
            `${detectedSources} local history ${detectedSources === 1 ? "folder detected" : "folders detected"}. Check your connections to choose which histories to read.`
          )}
          {(!sessionCount || scanning) && (
            <span className="mt-3 block">
              Your history stays on this device. Original files are never changed.
            </span>
          )}
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
              value={
                <span title="Recorded costs and model-price estimates, not your subscription bill.">
                  {money(knownCost(stats))}
                </span>
              }
              detail={
                stats.unpricedCalls > 0
                  ? `${integer(stats.unpricedCalls)} responses unpriced · known subtotal`
                  : `${money(stats.recordedCost)} recorded · ${money(stats.estimatedCost)} estimated`
              }
            />
            <Metric
              label="Sessions with usage"
              value={integer(stats.sessionCount)}
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
          <UsageOverTime stats={stats} start={start} now={now} range={range} />
          <div className="my-10">
            <div className="mb-10 grid grid-cols-2 gap-6 xl:grid-cols-4">
              <Metric
                label="Current streak"
                value={integer(streak.current)}
                detail="Consecutive active days"
              />
              <Metric
                label="Longest streak"
                value={integer(streak.longest)}
                detail="Consecutive active days · lifetime"
              />
              <Metric
                label="Active days"
                value={integer(streak.activeDays)}
                detail="Days with usage · lifetime"
              />
              <Metric
                label="Peak daily tokens"
                value={compact(streak.peak?.total ?? 0)}
                detail={`${streak.peak?.day ?? "No activity"} · lifetime`}
              />
            </div>
            <ActivityHeatmap lifetime={lifetime} now={now} openDay={openDay} />
          </div>
          <div className="mb-10 grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-12 [&_section>div:first-child]:min-h-7">
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
                label={(model) => model.label}
                description={(model) => offeringProviderNames(model).join(", ")}
              />
            </Section>
            <Section title="Most used tools">
              <RankedList
                items={tools.slice(0, 5)}
                itemKey={(tool) => tool.name}
                value={(tool) => tool.calls}
                formatValue={(tool) => integer(tool.calls)}
                title={(tool) =>
                  `${tool.name} · ${tool.agents.map((agent) => agents[agent].name).join(" · ")}`
                }
                ariaLabel={(tool) => `Find ${tool.name} in sessions`}
                onSelect={(tool) => openTool(tool.name)}
                labelClassName="truncate text-left font-mono"
                label={(tool) => tool.name}
                description={(tool) => tool.agents.map((agent) => agents[agent].name).join(" · ")}
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
            <SessionTable
              sessions={recent.sessions}
              boxed={false}
              onOpen={(id) => openSession(id)}
            />
          </Section>
        </>
      )}
    </>
  );
}
