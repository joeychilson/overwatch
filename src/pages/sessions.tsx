import {
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowLeft, ChevronLeft, ChevronRight, X } from "lucide-react";
import { startOfDay, subDays } from "date-fns";
import { agents } from "@/lib/agents";
import { useModelName } from "@/lib/hooks/use-model-name";
import { type Session } from "@/lib/bindings";
import { totalTokens } from "@/lib/usage/analytics";
import { day, integer } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import { Button } from "@/lib/components/ui/button";
import { FilterSelect, PageTitle, SearchField } from "@/lib/components/page";
import { SessionTable } from "@/lib/components/session-table";
import { SessionReader } from "@/lib/components/session-reader";
import { ErrorBoundary } from "@/lib/components/error-boundary";

export default function Sessions({
  sessions,
  selected,
  order,
  scrollRef,
  selectedDay,
  selectedTool,
  openSession,
  clearSelection,
  clearDay,
  clearTool,
  now,
}: {
  sessions: Session[];
  selected?: string;
  order?: string[];
  scrollRef: RefObject<HTMLDivElement | null>;
  selectedDay?: string;
  selectedTool?: string;
  openSession: (id: string, orderedIds: string[]) => void;
  clearSelection: () => void;
  clearDay: () => void;
  clearTool: () => void;
  now: number;
}) {
  const [search, setSearch] = useState("");
  const [range, setRange] = useState("all");
  const modelName = useModelName();
  const list = useRef<HTMLDivElement>(null);
  const place = useRef<{ page: number; id: string } | null>(null);
  const restoring = useRef(false);
  const deferred = useDeferredValue(search.toLowerCase());
  const start = range === "all" ? 0 : startOfDay(subDays(now, Number(range) - 1)).getTime();
  const filtered = useMemo(
    () =>
      sessions.filter(
        (session) =>
          session.updatedAt >= start &&
          (!selectedTool || session.tools.some((tool) => tool.name === selectedTool)) &&
          (!selectedDay ||
            session.usage.some((point) => day(point.timestamp) === selectedDay) ||
            day(session.startedAt) === selectedDay) &&
          `${session.title} ${session.cwd} ${session.model} ${modelName(session.model)}`
            .toLowerCase()
            .includes(deferred),
      ),
    [sessions, start, selectedTool, selectedDay, deferred, modelName],
  );
  const ordered = useMemo(() => {
    if (!order) return filtered.map((session) => session.id);
    const available = new Set(sessions.map((session) => session.id));
    return order.filter((id) => available.has(id));
  }, [order, sessions, filtered]);
  const position = selected ? ordered.indexOf(selected) : -1;
  const previous = position > 0 ? ordered[position - 1] : undefined;
  const next = position >= 0 ? ordered[position + 1] : undefined;
  useLayoutEffect(() => {
    if (selected || !restoring.current) return;
    restoring.current = false;
    const saved = place.current;
    let focusFrame = 0;
    let restoreFrame = 0;
    const table = list.current?.querySelector("table");
    const restore = () => {
      // A hidden virtual table first lays out its header, then measures and renders its rows.
      if (table && !table.querySelector("tbody [data-row-id]")) return;
      observer.disconnect();
      scrollRef.current?.scrollTo({ top: saved?.page ?? 0 });
      focusFrame = requestAnimationFrame(() => {
        const button = saved
          ? list.current?.querySelector<HTMLButtonElement>(
              `[data-row-id="${CSS.escape(saved.id)}"] button`,
            )
          : null;
        button?.focus({ preventScroll: true });
      });
    };
    // Restoring scroll can change virtual rows; do it after observer delivery.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(restoreFrame);
      restoreFrame = requestAnimationFrame(restore);
    });
    if (table) observer.observe(table);
    restore();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(focusFrame);
      cancelAnimationFrame(restoreFrame);
    };
  }, [selected, scrollRef]);
  const exportData = useMutation({
    mutationFn: () =>
      exportCsv("overwatch-sessions.csv", [
        [
          "Session",
          "Agent",
          "Project",
          "Model",
          "Tokens",
          "Uncached input",
          "Cached input",
          "Cache writes",
          "Output",
          "Reasoning (included in output)",
          "Started",
          "Updated",
          "Elapsed ms",
        ],
        ...filtered.map((session) => [
          session.title,
          agents[session.agent].name,
          session.cwd,
          session.model,
          totalTokens(session.tokens),
          session.tokens.input,
          session.tokens.cacheRead,
          session.tokens.cacheWrite,
          session.tokens.output,
          session.tokens.reasoning,
          new Date(session.startedAt).toISOString(),
          new Date(session.updatedAt).toISOString(),
          session.updatedAt - session.startedAt,
        ]),
      ]),
  });
  return (
    <>
      {selected && (
        <>
          <nav
            aria-label="Session navigation"
            className="sticky top-0 z-30 mb-6 flex h-14 items-center justify-between gap-4 bg-background"
          >
            <Button
              variant="ghost"
              className="-ml-3"
              aria-label="Back to sessions"
              onClick={() => {
                restoring.current = true;
                clearSelection();
              }}
            >
              <ArrowLeft />
              Sessions
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                aria-label="Previous session"
                disabled={!previous}
                onClick={() => previous && openSession(previous, ordered)}
              >
                <ChevronLeft />
                Previous
              </Button>
              {position >= 0 && (
                <span
                  aria-live="polite"
                  className="min-w-16 text-center text-xs text-muted-foreground tabular-nums"
                >
                  {integer(position + 1)} of {integer(ordered.length)}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                aria-label="Next session"
                disabled={!next}
                onClick={() => next && openSession(next, ordered)}
              >
                Next
                <ChevronRight />
              </Button>
            </div>
          </nav>
          <ErrorBoundary key={selected}>
            <SessionReader id={selected} scrollRef={scrollRef} />
          </ErrorBoundary>
        </>
      )}
      <div ref={list} hidden={!!selected}>
        <PageTitle
          title="Sessions"
          description={`${integer(sessions.length)} conversations across your local history.`}
          action={
            <Button
              variant="outline"
              disabled={exportData.isPending || !filtered.length}
              onClick={() => exportData.mutate()}
            >
              <ArrowDownToLine />
              Export
            </Button>
          }
        />
        <div className="mb-5 flex flex-wrap gap-3">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Search sessions, projects, or models…"
          />
          <FilterSelect
            label="Session date range"
            value={range}
            onChange={setRange}
            options={[
              { value: "all", label: "Any last activity" },
              { value: "7", label: "Active in last 7 days" },
              { value: "30", label: "Active in last 30 days" },
              { value: "90", label: "Active in last 90 days" },
            ]}
          />
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Dates filter sessions by their last activity. Tokens and elapsed time cover each entire
          session.
          {selectedDay &&
            " The selected day matches sessions with usage or a start on that local day."}
        </p>
        {selectedDay && (
          <Button variant="secondary" size="sm" className="mb-4" onClick={clearDay}>
            {selectedDay}
            <X />
          </Button>
        )}
        {selectedTool && (
          <Button
            variant="secondary"
            size="sm"
            className="mb-4"
            onClick={clearTool}
            aria-label="Clear tool filter"
          >
            {selectedTool}
            <X />
          </Button>
        )}
        <SessionTable
          sessions={filtered}
          scrollRef={scrollRef}
          onOpen={(id, orderedIds) => {
            place.current = {
              page: scrollRef.current?.scrollTop ?? 0,
              id,
            };
            openSession(id, orderedIds);
          }}
        />
        <p className="mt-5 text-xs text-muted-foreground">{integer(filtered.length)} sessions</p>
      </div>
    </>
  );
}
