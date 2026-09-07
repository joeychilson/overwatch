import { useMemo, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowLeft, ChevronLeft, ChevronRight, X } from "lucide-react";
import { startOfDay, subDays } from "date-fns";
import { useSessionSearch } from "@/lib/hooks/use-session-search";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { sessionQuery, sessionOptions, navigationOptions } from "@/lib/history";
import { commands, type HistoryScope, type SessionQuery } from "@/lib/bindings";
import { integer } from "@/lib/format";
import { native } from "@/lib/errors";
import { SessionFilters } from "@/lib/components/session-filters";
import { useModelName } from "@/lib/hooks/use-model-name";
import { Pagination } from "@/lib/components/pagination";
import { Skeleton } from "@/lib/components/ui/skeleton";
import { Button } from "@/lib/components/ui/button";
import { ErrorNotice, FilterSelect, PageTitle, SearchField } from "@/lib/components/page";
import { rowButton, whenPresent } from "@/lib/components/restore-focus";
import { SessionTable } from "@/lib/components/session-table";
import { SessionReader } from "@/lib/components/session-reader";
import { ErrorBoundary } from "@/lib/components/error-boundary";

export default function Sessions({
  scope,
  initialSearch = "",
  selected,
  selectedQuery,
  scrollRef,
  selectedDay,
  selectedTool,
  openSession,
  clearSelection,
  clearDay,
  clearTool,
  now,
}: {
  scope: HistoryScope;
  initialSearch?: string;
  selected?: string;
  selectedQuery?: SessionQuery;
  scrollRef: RefObject<HTMLDivElement | null>;
  selectedDay?: string;
  selectedTool?: string;
  openSession: (id: string, query: SessionQuery) => void;
  clearSelection: () => void;
  clearDay: () => void;
  clearTool: () => void;
  now: number;
}) {
  const [search, setSearch] = useState(initialSearch);
  const [model, setModel] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);
  const modelName = useModelName();
  const activeTool = selectedTool ?? tool;
  const [range, setRange] = useState("all");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<SessionQuery["sort"]>("updatedAt");
  const [descending, setDescending] = useState(true);
  const deferred = useDebounced(search);
  const searchModels = useSessionSearch(deferred);
  const list = useRef<HTMLDivElement>(null);
  const place = useRef<{ page: number; id: string } | null>(null);
  const restoring = useRef(false);
  const start = range === "all" ? null : startOfDay(subDays(now, Number(range) - 1)).getTime();
  const query = sessionQuery(scope, {
    search: deferred,
    searchModels,
    activityAfter: start,
    day: selectedDay ?? null,
    tool: activeTool,
    model,
    failedOnly,
    offset,
    sort,
    descending,
  });
  const page = useQuery(sessionOptions(query));
  const filtered = useMemo(() => page.data?.sessions ?? [], [page.data]);
  const context = selectedQuery ?? query;
  const navigation = useQuery(navigationOptions(selected ?? "", context));
  const position = navigation.data?.position ?? -1;
  const previous = navigation.data?.previous;
  const next = navigation.data?.next;
  useLayoutEffect(() => {
    if (selected || !restoring.current) return;
    const root = list.current;
    if (!root) return;
    const saved = place.current;
    return whenPresent(root, () => {
      const table = root.querySelector("table");
      if (table && !table.querySelector("tbody [data-row-id]")) return false;
      scrollRef.current?.scrollTo({ top: saved?.page ?? 0 });
      const button = saved ? rowButton(root, saved.id) : null;
      if (saved && filtered.some((session) => session.id === saved.id) && !button) return false;
      button?.focus({ preventScroll: true });
      restoring.current = false;
      return true;
    });
  }, [selected, scrollRef, filtered]);
  const exportData = useMutation({ mutationFn: () => native(commands.exportSessions(query)) });
  const changePage = (offset: number) => {
    setOffset(offset);
    scrollRef.current?.scrollTo({ top: 0 });
  };
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
                onClick={() => previous && openSession(previous, context)}
              >
                <ChevronLeft />
                Previous
              </Button>
              {position >= 0 && (
                <span
                  aria-live="polite"
                  className="min-w-16 text-center text-xs text-muted-foreground tabular-nums"
                >
                  {integer(position + 1)} of {integer(navigation.data?.total ?? 0)}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                aria-label="Next session"
                disabled={!next}
                onClick={() => next && openSession(next, context)}
              >
                Next
                <ChevronRight />
              </Button>
            </div>
          </nav>
          {navigation.error && (
            <ErrorNotice error={navigation.error} retry={() => void navigation.refetch()} />
          )}
          <ErrorBoundary key={selected}>
            <SessionReader id={selected} scrollRef={scrollRef} />
          </ErrorBoundary>
        </>
      )}
      <div ref={list} hidden={!!selected}>
        <PageTitle
          title="Sessions"
          description={`${integer(page.data?.total ?? 0)} conversations across your local history.`}
          action={
            <Button
              variant="outline"
              disabled={exportData.isPending || !filtered.length || search !== deferred}
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
            onChange={(value) => {
              setSearch(value);
              setOffset(0);
            }}
            placeholder="Search sessions, projects, or models…"
          />
          <FilterSelect
            label="Session date range"
            value={range}
            onChange={(value) => {
              setRange(value);
              setOffset(0);
            }}
            options={[
              { value: "all", label: "Any last activity" },
              { value: "7", label: "Active in last 7 days" },
              { value: "30", label: "Active in last 30 days" },
              { value: "90", label: "Active in last 90 days" },
            ]}
          />
          <SessionFilters
            scope={scope}
            model={model}
            tool={activeTool}
            failedOnly={failedOnly}
            onChange={(filters) => {
              setModel(filters.model);
              setTool(filters.tool);
              setFailedOnly(filters.failedOnly);
              setOffset(0);
              if (selectedTool) clearTool();
            }}
          />
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Dates filter sessions by their last activity. Tokens and elapsed time cover each entire
          session.
          {selectedDay &&
            " The selected day matches sessions with usage or a start on that local day."}
        </p>
        {(selectedDay || activeTool || model || failedOnly) && (
          <div className="mb-4 flex flex-wrap gap-2">
            {selectedDay && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  clearDay();
                  setOffset(0);
                }}
                aria-label="Clear day filter"
              >
                {selectedDay}
                <X />
              </Button>
            )}
            {model && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setModel(null);
                  setOffset(0);
                }}
                aria-label="Clear model filter"
              >
                {modelName(model)}
                <X />
              </Button>
            )}
            {activeTool && (
              <Button
                variant="secondary"
                size="sm"
                className="max-w-full"
                onClick={() => {
                  clearTool();
                  setTool(null);
                  setOffset(0);
                }}
                aria-label="Clear tool filter"
              >
                <span className="truncate">{activeTool}</span>
                <X />
              </Button>
            )}
            {failedOnly && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setFailedOnly(false);
                  setOffset(0);
                }}
                aria-label="Clear failure filter"
              >
                Failed tool calls
                <X />
              </Button>
            )}
          </div>
        )}
        {page.error && <ErrorNotice error={page.error} retry={() => void page.refetch()} />}
        {page.isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : (
          <>
            {page.data && <Pagination {...page.data} busy={page.isFetching} onPage={changePage} />}
            <SessionTable
              query={query}
              onSort={(sort, descending) => {
                setSort(sort);
                setDescending(descending);
                setOffset(0);
              }}
              sessions={filtered}
              scrollRef={scrollRef}
              onOpen={(id) => {
                place.current = {
                  page: scrollRef.current?.scrollTop ?? 0,
                  id,
                };
                openSession(id, query);
              }}
            />
          </>
        )}
      </div>
    </>
  );
}
