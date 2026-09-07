import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowLeft } from "lucide-react";
import { agentIds, agents } from "@/lib/agents";
import type { Agent, Session } from "@/lib/bindings";
import type { Model } from "@/lib/models/catalog";
import { aggregate } from "@/lib/usage/analytics";
import { knownCost } from "@/lib/usage/costs";
import { compact, integer, money } from "@/lib/format";
import { rowButton, whenPresent } from "@/lib/components/restore-focus";
import { offeringProviderNames, usageGroups, type UsageGroup } from "@/lib/usage/groups";
import { DataTable, type DataColumn } from "@/lib/components/data-table";
import { FilterSelect, Metric, Section } from "@/lib/components/page";
import { ProviderMark } from "@/lib/components/provider-mark";
import { SessionTable } from "@/lib/components/session-table";
import { Button } from "@/lib/components/ui/button";
import { Skeleton } from "@/lib/components/ui/skeleton";
import { UsageOverTime } from "@/lib/components/usage-over-time";

const SessionReader = lazy(() =>
  import("@/lib/components/session-reader").then((module) => ({ default: module.SessionReader })),
);

export function ModelDetail({
  group,
  scrollRef,
  sessions,
  models,
  start,
  end,
  now,
  range,
  onClose,
}: {
  group: UsageGroup;
  scrollRef: RefObject<HTMLDivElement | null>;
  sessions: Session[];
  models: Model[];
  start: number;
  end: number;
  now: number;
  range: number;
  onClose: () => void;
}) {
  const [reading, setReading] = useState<string>();
  const analysisPosition = useRef(0);
  const sessionScroll = useRef<HTMLDivElement>(null);
  const restoreSession = useRef<string | undefined>(undefined);
  const [provider, setProvider] = useState("all");
  const [agent, setAgent] = useState<Agent | "all">("all");
  const matched = useMemo(() => {
    const keys = new Set(
      group.offerings
        .filter((offering) => provider === "all" || offering.provider === provider)
        .map((offering) => offering.key),
    );
    return sessions.flatMap((session) => {
      if (agent !== "all" && session.agent !== agent) return [];
      const usage = session.usage.filter(
        (usage) =>
          usage.timestamp >= start &&
          usage.timestamp < end &&
          keys.has(`${usage.provider}/${usage.model}`),
      );
      return usage.length ? [{ ...session, usage }] : [];
    });
  }, [group.offerings, provider, agent, sessions, start, end]);
  const stats = useMemo(
    () => aggregate(matched, models, start, end),
    [matched, models, start, end],
  );
  const providers = [
    ...new Map(
      group.offerings.map((offering) => [offering.provider, offering.providerName]),
    ).entries(),
  ];
  const sourceRows = useMemo(() => usageGroups(stats.models, "provider"), [stats.models]);
  const sourceColumns: DataColumn<UsageGroup>[] = [
    {
      id: "provider",
      header: "Provider",
      accessorKey: "label",
      width: 220,
      grow: true,
      cell: ({ row }) => (
        <div className="flex items-center gap-3">
          <ProviderMark provider={row.original.key} />
          <div className="min-w-0">
            <p className="truncate font-medium">{row.original.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {integer(row.original.calls)} {row.original.calls === 1 ? "response" : "responses"}
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "tokens",
      header: "Tokens",
      accessorKey: "tokens",
      width: 95,
      cell: ({ row }) => compact(row.original.tokens),
    },
    {
      id: "cost",
      header: "Cost (USD)",
      accessorFn: (row) => knownCost(row) ?? -1,
      width: 165,
      cell: ({ row }) => (
        <div className="tabular-nums">
          <p>{money(knownCost(row.original))}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {row.original.recordedCost > 0 && row.original.estimatedCost > 0
              ? `${money(row.original.recordedCost)} recorded · ${money(row.original.estimatedCost)} estimated`
              : row.original.recordedCost > 0
                ? "Recorded"
                : row.original.estimatedCost > 0
                  ? "Estimated"
                  : row.original.pricedCalls > 0
                    ? "Priced usage"
                    : "Unavailable"}
          </p>
        </div>
      ),
    },
    {
      id: "coverage",
      header: "Coverage",
      accessorFn: (row) => row.pricedCalls / Math.max(1, row.calls),
      width: 120,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.unpricedCalls
            ? `${integer(row.original.unpricedCalls)} unpriced`
            : "All priced"}
        </span>
      ),
    },
  ];
  const openSession = (id: string) => {
    analysisPosition.current = scrollRef.current?.scrollTop ?? 0;
    setReading(id);
    scrollRef.current?.scrollTo({ top: 0 });
  };
  useLayoutEffect(() => {
    const root = sessionScroll.current;
    const id = restoreSession.current;
    if (reading || !root || !id) return;
    return whenPresent(root, () => {
      const button = rowButton(root, id);
      if (!button?.getClientRects().length) return false;
      button.focus();
      restoreSession.current = undefined;
      return true;
    });
  }, [reading]);
  return (
    <>
      {!reading && (
        <>
          <nav aria-label="Model navigation" className="mb-6 flex h-14 items-center">
            <Button variant="ghost" className="-ml-3" onClick={onClose} aria-label="Back to models">
              <ArrowLeft />
              Models
            </Button>
          </nav>
          <div className="mb-7 flex items-start gap-4">
            <ProviderMark provider={group.offerings[0].identity.owner} className="mt-1 size-10" />
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl leading-snug font-semibold tracking-tight">{group.label}</h1>
              <p className="mt-2 text-xs text-muted-foreground">
                {offeringProviderNames(group).join(" · ")}
                <span className="mx-2">/</span>
                {new Date(start).toLocaleDateString()} – {new Date(end - 1).toLocaleDateString()}
              </p>
            </div>
          </div>
        </>
      )}
      {reading && (
        <div>
          <nav
            aria-label="Session navigation"
            className="sticky top-0 z-30 mb-6 flex h-14 items-center bg-background"
          >
            <Button
              variant="ghost"
              className="-ml-3"
              aria-label="Back to model analysis"
              onClick={() => {
                restoreSession.current = reading;
                setReading(undefined);
                requestAnimationFrame(() =>
                  scrollRef.current?.scrollTo({ top: analysisPosition.current }),
                );
              }}
            >
              <ArrowLeft />
              {group.label}
            </Button>
          </nav>
          <p className="mb-4 text-xs text-muted-foreground">
            Full session transcript · includes all models and dates. Your analysis filters are
            retained.
          </p>
          <div>
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <SessionReader key={reading} id={reading} scrollRef={scrollRef} />
            </Suspense>
          </div>
        </div>
      )}
      <div hidden={!!reading} className="space-y-8">
        {!group.resolved && (
          <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
            This identity is not verified across providers. Its recorded offering remains separate;
            matching display names are not evidence of the same model.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <FilterSelect
            label="Model provider filter"
            value={provider}
            onChange={setProvider}
            options={[
              { value: "all", label: "All providers" },
              ...providers.map(([value, label]) => ({ value, label })),
            ]}
          />
          <FilterSelect
            label="Model agent filter"
            value={agent}
            onChange={setAgent}
            options={[
              { value: "all", label: "All agents" },
              ...agentIds.map((value) => ({ value, label: agents[value].name })),
            ]}
          />
        </div>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Metric
            label="Model tokens"
            value={compact(stats.total)}
            detail={`${integer(stats.calls)} ${stats.calls === 1 ? "response" : "responses"}`}
          />
          <Metric
            label="Known USD"
            value={money(knownCost(stats))}
            detail={
              stats.unpricedCalls
                ? `${integer(stats.unpricedCalls)} ${stats.unpricedCalls === 1 ? "response" : "responses"} unpriced`
                : "Recorded costs and estimates"
            }
          />
          <Metric label="Sessions" value={integer(matched.length)} detail="In selected period" />
          <Metric
            label="Agents"
            value={integer(new Set(matched.map((session) => session.agent)).size)}
            detail="Coding agents"
          />
        </div>
        <UsageOverTime stats={stats} start={start} now={now} range={range} visible={!reading} />
        <Section title="Providers">
          <DataTable
            label="Model provider costs"
            data={sourceRows}
            columns={sourceColumns}
            rowKey={(row) => row.key}
            className="max-h-65"
          />
        </Section>
        <Section
          title="Sessions"
          action={
            <span className="text-xs text-muted-foreground">
              {integer(matched.length)} sessions
            </span>
          }
        >
          <SessionTable
            label="Model contributing sessions"
            sessions={matched}
            usageOnly
            boxed
            scrollRef={sessionScroll}
            onOpen={openSession}
          />
          <p className="mt-5 text-xs text-muted-foreground">
            Tokens and responses include this model’s usage in the selected period. Open a session
            to read its full conversation.
          </p>
        </Section>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer rounded py-2">Recorded model identifiers</summary>
          <ul className="mt-2 space-y-2">
            {group.offerings.map((offering) => (
              <li key={offering.key} className="break-all">
                {offering.providerName} · <code>{offering.model}</code>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </>
  );
}
