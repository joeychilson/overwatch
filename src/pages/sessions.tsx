import { useLayoutEffect, useRef, type RefObject } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowLeft, ChevronLeft, ChevronRight, X } from "lucide-react";
import { startOfDay, subDays } from "date-fns";
import { useWorkspaceField, useWorkspace } from "@/lib/shell/use-workspace";
import { useSessionSearch } from "@/lib/hooks/use-session-search";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { sessionQuery, navigationOptions } from "@/lib/history";
import { commands, type HistoryScope, type SessionQuery } from "@/lib/bindings";
import { confirmExport } from "@/lib/export";
import { integer } from "@/lib/format";
import { native } from "@/lib/errors";
import { SessionFilters } from "@/lib/components/session-filters";
import { useModelName } from "@/lib/hooks/use-model-name";
import { useSessionFeed } from "@/lib/hooks/use-session-feed";
import { TableSkeleton } from "@/lib/components/page-skeleton";
import { Button } from "@/lib/components/ui/button";
import { ErrorNotice, FilterSelect, PageTitle, SearchField } from "@/lib/components/page";
import { rowButton, whenPresent } from "@/lib/components/restore-focus";
import { SessionTable } from "@/lib/components/session-table";
import { SessionReader } from "@/lib/components/session-reader";
import { ErrorBoundary } from "@/lib/components/error-boundary";

export default function Sessions({
  scope,
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
  const [controls, setControls] = useWorkspaceField("sessions");
  const { restore } = useWorkspace();
  const { search, range, offset, sort, descending, model, tool, failedOnly } = controls;
  const setSearch = (search: string) => setControls((previous) => ({ ...previous, search }));
  const setRange = (range: string) =>
    setControls((previous) => ({ ...previous, range: range as typeof previous.range }));
  const setOffset = (offset: number) => setControls((previous) => ({ ...previous, offset }));
  const setSort = (sort: SessionQuery["sort"]) =>
    setControls((previous) => ({ ...previous, sort }));
  const setDescending = (descending: boolean) =>
    setControls((previous) => ({ ...previous, descending }));
  const setModel = (model: string | null) => setControls((previous) => ({ ...previous, model }));
  const setTool = (tool: string | null) => setControls((previous) => ({ ...previous, tool }));
  const setFailedOnly = (failedOnly: boolean) =>
    setControls((previous) => ({ ...previous, failedOnly }));
  const modelName = useModelName();
  const activeTool = selectedTool ?? tool;
  const deferred = useDebounced(search);
  const searchModels = useSessionSearch(deferred);
  const list = useRef<HTMLDivElement>(null);
  const place = useRef<{ page: number; id: string } | null>(
    controls.focus ? { page: controls.scroll, id: controls.focus } : null,
  );
  const restoring = useRef(!!controls.focus);
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
  const page = useSessionFeed(query);
  const filtered = page.sessions;
  const context = selectedQuery ?? query;
  const navigation = useQuery(navigationOptions(selected ?? "", context));
  const position = navigation.data?.position ?? -1;
  const previous = navigation.data?.previous;
  const next = navigation.data?.next;
  const lastSelected = useRef(selected);
  const lastRestore = useRef(restore.revision);
  useLayoutEffect(() => {
    if (restore.revision !== lastRestore.current) {
      place.current = controls.focus ? { id: controls.focus, page: controls.scroll } : null;
      lastRestore.current = restore.revision;
    }
    if (lastSelected.current && !selected) restoring.current = true;
    lastSelected.current = selected;
    if (selected || !restoring.current) return;
    const root = list.current;
    if (!root) return;
    const saved = place.current;
    return whenPresent(root, () => {
      const table = root.querySelector("table");
      if (table && !table.querySelector("tbody [data-row-id]")) return false;
      scrollRef.current?.scrollTo({ top: saved?.page ?? 0 });
      const button = saved ? rowButton(root, saved.id) : null;
      if (
        saved &&
        !button &&
        (page.hasNextPage || filtered.some((session) => session.id === saved.id))
      )
        return false;
      button?.focus({ preventScroll: true });
      restoring.current = false;
      return true;
    });
  }, [
    selected,
    scrollRef,
    filtered,
    restore.revision,
    controls.focus,
    controls.scroll,
    page.hasNextPage,
  ]);
  const exportData = useMutation({
    mutationFn: () => native(commands.exportSessions(query)),
    onSuccess: confirmExport,
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
          description={`${integer(page.total)} conversations across your local history.`}
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
                title="Sessions with usage or a start on this local day"
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
        {page.error && !page.isFetchNextPageError && (
          <ErrorNotice
            error={page.error}
            retry={() => void (page.isFetchNextPageError ? page.fetchNextPage() : page.refetch())}
          />
        )}
        {page.isPending ? (
          <TableSkeleton />
        ) : (
          <>
            <SessionTable
              query={query}
              onSort={(sort, descending) => {
                setSort(sort);
                setDescending(descending);
                setOffset(0);
              }}
              sessions={filtered}
              active={!selected}
              onEndReached={page.loadMore}
              hasMore={page.hasNextPage && !page.isFetchNextPageError}
              scrollRef={scrollRef}
              onOpen={(id) => {
                place.current = {
                  page: scrollRef.current?.scrollTop ?? 0,
                  id,
                };
                setControls((previous) => ({
                  ...previous,
                  scroll: Math.round(place.current?.page ?? 0),
                  focus: id,
                }));
                openSession(id, query);
              }}
            />
            {page.isFetchNextPageError && (
              <ErrorNotice error={page.error} retry={() => void page.fetchNextPage()} />
            )}
            <p role="status" className="mt-5 text-xs text-muted-foreground">
              {page.isFetchingNextPage
                ? "Loading more sessions…"
                : `${integer(filtered.length)} of ${integer(page.total)} sessions`}
            </p>
          </>
        )}
      </div>
    </>
  );
}
