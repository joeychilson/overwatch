import { useDeferredValue, useMemo, useRef, useState, type RefObject } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpToLine, Download, ExternalLink } from "lucide-react";
import { format } from "date-fns";
import { commands } from "@/lib/bindings";
import { native } from "@/lib/errors";
import { compact, duration, elapsed, hasTimestamp, integer, money } from "@/lib/format";
import { aggregate, knownCost, totalTokens } from "@/lib/usage/analytics";
import { catalogOptions, eventPageOptions } from "@/lib/queries";
import { useModelName } from "@/lib/hooks/use-model-name";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { ErrorNotice, Metric, SearchField } from "./page";
import { AgentMark } from "./agent-mark";
import { Timeline } from "./timeline";
import { SessionMetric } from "./session-metric";
import { SessionLog, type SessionLogHandle } from "./session-log";

export function SessionReader({
  id,
  scrollRef,
}: {
  id: string;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [search, setSearch] = useState("");
  const [titleExpanded, setTitleExpanded] = useState(false);
  const [position, setPosition] = useState({ index: 0, focus: false });
  const deferred = useDeferredValue(search);
  const log = useRef<SessionLogHandle>(null);
  const transcript = useQuery({
    queryKey: ["transcript", id],
    queryFn: () => native(commands.getTranscript(id)),
  });
  const results = useQuery({
    ...eventPageOptions(id, deferred, 0),
    queryKey: ["events", id, "search", deferred],
    enabled: !!deferred,
  });
  const exportData = useMutation({ mutationFn: () => native(commands.exportSession(id)) });
  const source = useMutation({ mutationFn: () => native(commands.openSessionSource(id)) });
  const catalog = useQuery(catalogOptions);
  const modelName = useModelName();
  const stats = useMemo(
    () => aggregate(transcript.data ? [transcript.data.session] : [], catalog.data?.models ?? []),
    [transcript.data, catalog.data],
  );
  if (!transcript.data)
    return transcript.error ? (
      <ErrorNotice error={transcript.error} retry={() => void transcript.refetch()} />
    ) : (
      <Skeleton className="h-96 w-full rounded-xl" />
    );
  const { session, timeline } = transcript.data;
  function jumpTo(index: number) {
    setPosition({ index, focus: true });
    setSearch("");
    if (!deferred) log.current?.jumpTo(index);
  }
  return (
    <>
      {transcript.error && (
        <ErrorNotice error={transcript.error} retry={() => void transcript.refetch()} />
      )}
      <div className="mb-7 flex items-start gap-4">
        <AgentMark agent={session.agent} className="mt-1 size-10" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl leading-snug font-semibold tracking-tight">
            <button
              type="button"
              className="block w-full rounded text-left"
              title={session.title}
              aria-expanded={titleExpanded}
              onClick={() => setTitleExpanded(!titleExpanded)}
            >
              <span className={titleExpanded ? "wrap-break-word" : "line-clamp-2 wrap-break-word"}>
                {session.title}
              </span>
            </button>
          </h1>
          <p className="mt-2 truncate text-xs text-muted-foreground" title={session.cwd}>
            {session.project} <span className="mx-2">/</span>{" "}
            <span title={session.model}>{modelName(session.model)}</span>{" "}
            <span className="mx-2">/</span>
            {hasTimestamp(session.startedAt)
              ? format(session.startedAt, "MMM d, yyyy · HH:mm xxx")
              : "Time unknown"}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={exportData.isPending}
          onClick={() => exportData.mutate()}
        >
          <Download />
          Export JSON
        </Button>
      </div>
      <div className="mb-7 grid grid-cols-3 gap-x-6 gap-y-5 min-[1200px]:grid-cols-6">
        <Metric label="Elapsed" value={duration(elapsed(session.startedAt, session.updatedAt))} />
        <Metric label="Turns" value={integer(session.turns)} />
        <Metric label="Messages" value={integer(session.messages)} />
        <SessionMetric label="Tokens" value={compact(totalTokens(session.tokens))}>
          <dl className="space-y-3">
            {(
              [
                ["Uncached input", session.tokens.input],
                ["Cached input", session.tokens.cacheRead],
                ["Cache writes", session.tokens.cacheWrite],
                ["Output", session.tokens.output],
                ["Reasoning · included in output", session.tokens.reasoning],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 text-xs">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="tabular-nums">{integer(value)}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-5 rounded-lg bg-muted/60 p-3">
            <div className="flex justify-between gap-4 text-xs">
              <span className="text-muted-foreground">API equivalent</span>
              <span className="font-medium tabular-nums">{money(knownCost(stats))}</span>
            </div>
            {stats.unpricedCalls > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {integer(stats.unpricedCalls)} responses unpriced · {compact(stats.unpriced)} tokens
              </p>
            )}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            {money(stats.recordedCost)} recorded · {money(stats.estimatedCost)} estimated (USD).{" "}
            Recorded costs when available; current catalog rates otherwise. Not your subscription
            bill.
          </p>
          {stats.undatedCalls > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Includes {integer(stats.undatedCalls)}{" "}
              {stats.undatedCalls === 1 ? "response" : "responses"} without usable timestamps. This
              usage is excluded from Overview date ranges and calendar activity.
            </p>
          )}
        </SessionMetric>
        <SessionMetric
          label="Tool calls"
          value={integer(session.tools.reduce((sum, tool) => sum + tool.calls, 0))}
        >
          {session.tools.length ? (
            <table
              className="w-full table-fixed text-left text-xs"
              aria-label="Session tool activity"
            >
              <colgroup>
                <col />
                <col style={{ width: 44 }} />
                <col style={{ width: 48 }} />
                <col style={{ width: 66 }} />
              </colgroup>
              <thead>
                <tr className="text-[11px] text-muted-foreground">
                  <th className="pb-2 font-normal">Tool</th>
                  <th className="pb-2 text-right font-normal">Calls</th>
                  <th className="pb-2 text-right font-normal">Failed</th>
                  <th className="pb-2 text-right font-normal">Elapsed</th>
                </tr>
              </thead>
              <tbody>
                {session.tools.map((tool) => (
                  <tr key={tool.name}>
                    <td className="truncate py-2 pr-3 font-mono" title={tool.name}>
                      {tool.name}
                    </td>
                    <td className="text-right tabular-nums">{integer(tool.calls)}</td>
                    <td className="text-right tabular-nums">{tool.failures || "—"}</td>
                    <td className="text-right whitespace-nowrap tabular-nums">
                      {duration(tool.timed > 0 ? tool.durationMs : null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-muted-foreground">No tool calls recorded in this session.</p>
          )}
        </SessionMetric>
        <Metric label="Compactions" value={integer(session.compactions)} />
      </div>
      {session.warnings.map((warning) => (
        <p
          role="status"
          key={warning}
          className="mb-4 rounded-lg bg-warning/10 p-3 text-xs text-warning"
        >
          {warning}
        </p>
      ))}
      {timeline.length > 0 && (
        <section aria-label="Timeline" className="mb-4">
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <h2 className="text-sm font-medium text-foreground">Timeline</h2>
            <span className="ml-auto text-[11px]">Select an event to jump to its message</span>
          </div>
          <Timeline events={timeline} selected={position.index} onSelect={jumpTo} />
          <p className="mt-2 text-[11px] text-muted-foreground">
            Elapsed time includes idle gaps. Marks show recorded events and tool durations, not
            inference timings.
          </p>
        </section>
      )}
      <div className="sticky top-14 z-20 flex h-16 items-center gap-3 bg-background py-3">
        <SearchField
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPosition({ index: 0, focus: false });
          }}
          placeholder="Search the entire transcript…"
        />
        <span
          aria-live="polite"
          className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
        >
          {search !== deferred || (deferred && results.isPending)
            ? "Searching…"
            : deferred
              ? `${integer(results.data?.total ?? 0)} matches`
              : `${integer(timeline.length)} events`}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Jump to start"
            disabled={!timeline.length}
            onClick={() => jumpTo(0)}
          >
            <ArrowUpToLine />
            Start
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Jump to latest"
            disabled={!timeline.length}
            onClick={() => jumpTo(timeline.length - 1)}
          >
            <ArrowDownToLine />
            Latest
          </Button>
        </div>
      </div>
      {deferred && results.error && (
        <ErrorNotice error={results.error} retry={() => void results.refetch()} />
      )}
      {!deferred || results.data ? (
        <SessionLog
          key={deferred}
          ref={log}
          id={id}
          cwd={session.cwd}
          timeline={timeline}
          view={
            deferred && results.data
              ? { kind: "search", query: deferred, firstPage: results.data }
              : { kind: "all" }
          }
          initialPosition={position}
          scrollRef={scrollRef}
        />
      ) : results.isPending ? (
        <Skeleton className="h-52 w-full rounded-xl" />
      ) : null}
      <footer className="mt-8 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 pb-4 text-[11px] text-muted-foreground">
        <button
          type="button"
          onClick={() => source.mutate()}
          disabled={source.isPending}
          title={session.sourcePath}
          className="flex max-w-full min-w-0 items-center gap-2 rounded hover:text-foreground hover:underline disabled:opacity-50"
        >
          <ExternalLink className="size-3.5" />
          <span className="truncate">Open source · {session.sourcePath.split(/[\\/]/).pop()}</span>
        </button>
        {session.parentId && (
          <span className="min-w-0 truncate" title={session.parentId}>
            Parent session · {session.parentId}
          </span>
        )}
      </footer>
    </>
  );
}
