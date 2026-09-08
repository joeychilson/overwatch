import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Download,
  ExternalLink,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { format } from "date-fns";
import { commands } from "@/lib/bindings";
import { AppFailure, native } from "@/lib/errors";
import { hasTimestamp, integer } from "@/lib/format";
import { eventPageOptions } from "@/lib/queries";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { confirmExport } from "@/lib/export";
import { useWorkspace } from "@/lib/hooks/use-workspace";
import { useModelName } from "@/lib/hooks/use-model-name";
import { Button } from "./ui/button";
import { ReaderSkeleton, MessagesSkeleton } from "./page-skeleton";
import { ErrorNotice, PageHeader, SearchField } from "./page";
import { AgentMark } from "./agent-mark";
import { Timeline } from "./timeline";
import { SessionStats } from "./session-stats";
import { SessionLog, type SessionLogHandle } from "./session-log";

export function SessionReader({
  id,
  scrollRef,
}: {
  id: string;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { state, change, saveReader } = useWorkspace();
  const savedPosition = state.readers.find((reader) => reader.id === id)?.index ?? 0;
  const onPosition = useCallback((index: number) => saveReader(id, index), [id, saveReader]);
  const [search, setSearch] = useState("");
  const [match, setMatch] = useState(0);
  const [titleExpanded, setTitleExpanded] = useState(false);
  const [position, setPosition] = useState({ index: savedPosition, focus: false });
  const debouncedSearch = useDebounced(search);
  // Clear immediately so a pending debounce cannot remount the log after a timeline jump.
  const deferred = search ? debouncedSearch : "";
  const log = useRef<SessionLogHandle>(null);
  const transcript = useQuery({
    queryKey: ["transcript", id],
    queryFn: () => native(commands.getTranscript(id)),
  });
  useEffect(() => {
    if (!(transcript.error instanceof AppFailure) || transcript.error.detail.kind !== "notFound")
      return;
    change((previous) => {
      const route = previous.route;
      if (route.view === "sessions" && route.id === id)
        return { ...previous, route: { ...route, id: undefined } };
      if (route.view === "models" && route.reading === id)
        return { ...previous, route: { ...route, reading: undefined } };
      return previous;
    });
  }, [transcript.error, change, id]);
  const results = useQuery({
    ...eventPageOptions(id, deferred, 0),
    queryKey: ["events", id, "search", deferred],
    enabled: !!deferred,
  });
  const matches = results.data?.total ?? 0;
  const searching = search !== deferred || (!!deferred && results.isFetching);
  const currentMatch = Math.max(0, Math.min(match, matches - 1));
  function moveMatch(direction: number) {
    if (searching || !matches) return;
    const next = Math.max(0, Math.min(matches - 1, currentMatch + direction));
    setMatch(next);
    log.current?.jumpTo(next, false);
  }
  const exportData = useMutation({
    mutationFn: () => native(commands.exportSession(id)),
    onSuccess: confirmExport,
  });
  const source = useMutation({ mutationFn: () => native(commands.openSessionSource(id)) });
  const modelName = useModelName();
  if (!transcript.data)
    return transcript.error ? (
      <ErrorNotice error={transcript.error} retry={() => void transcript.refetch()} />
    ) : (
      <ReaderSkeleton />
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
      <PageHeader
        icon={<AgentMark agent={session.agent} className="size-10" />}
        title={
          <button
            type="button"
            className="block w-full rounded text-left"
            title={session.title}
            aria-expanded={titleExpanded}
            onClick={() => setTitleExpanded((expanded) => !expanded)}
          >
            <span className={titleExpanded ? "wrap-break-word" : "line-clamp-2 wrap-break-word"}>
              {session.title}
            </span>
          </button>
        }
        description={
          <span title={session.cwd}>
            {session.project} <span className="mx-2">/</span>{" "}
            <span title={session.model}>{modelName(session.model)}</span>{" "}
            <span className="mx-2">/</span>
            {hasTimestamp(session.startedAt)
              ? format(session.startedAt, "MMM d, yyyy · HH:mm xxx")
              : "Time unknown"}
          </span>
        }
        action={
          <Button
            variant="outline"
            disabled={exportData.isPending}
            onClick={() => exportData.mutate()}
          >
            <Download />
            Export JSON
          </Button>
        }
      />
      <SessionStats session={session} />
      {session.warnings.map((warning) => (
        <p
          role="status"
          key={warning}
          className="mb-4 rounded-lg bg-warning/10 p-3 text-xs text-warning"
        >
          {warning}
        </p>
      ))}
      {timeline.count > 0 && (
        <section aria-label="Timeline" className="mb-4">
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <h2 className="text-sm font-medium text-foreground">Timeline</h2>
            <span className="ml-auto text-[11px]">Select a mark to jump to its message</span>
          </div>
          <Timeline id={id} overview={timeline} selected={position.index} onSelect={jumpTo} />
          <p className="mt-2 text-[11px] text-muted-foreground">
            Elapsed time includes idle gaps. Marks show recorded events and tool durations, not
            inference timings.
            {timeline.marks.length < timeline.count &&
              " Nearby marks are grouped. Arrow keys move one event at a time."}
          </p>
        </section>
      )}
      <div className="sticky top-14 z-20 flex h-16 items-center gap-3 bg-background py-3">
        <SearchField
          value={search}
          onChange={(value) => {
            setSearch(value);
            setMatch(0);
            setPosition({ index: 0, focus: false });
          }}
          placeholder="Search the entire transcript…"
          onKeyDown={(event) => {
            if (event.key === "Enter" && deferred) {
              event.preventDefault();
              moveMatch(event.shiftKey ? -1 : 1);
            }
          }}
        />
        <span
          aria-live="polite"
          className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
        >
          {searching
            ? "Searching…"
            : deferred
              ? `${matches ? currentMatch + 1 : 0} of ${integer(matches)} matching events`
              : `${integer(timeline.count)} events`}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {deferred ? (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Previous match"
                disabled={searching || !matches || currentMatch === 0}
                onClick={() => moveMatch(-1)}
              >
                <ChevronUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Next match"
                disabled={searching || !matches || currentMatch >= matches - 1}
                onClick={() => moveMatch(1)}
              >
                <ChevronDown />
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Jump to start"
                disabled={!timeline.count}
                onClick={() => jumpTo(0)}
              >
                <ArrowUpToLine />
                Start
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Jump to latest"
                disabled={!timeline.count}
                onClick={() => jumpTo(timeline.count - 1)}
              >
                <ArrowDownToLine />
                Latest
              </Button>
            </>
          )}
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
          onPosition={onPosition}
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
        <MessagesSkeleton />
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
