import {
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";
import { useMutation, useQueries } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Brain,
  ChevronRight,
  Copy,
  FileText,
  RotateCcw,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import type { EventPage, SessionEvent, TimelineSummary } from "@/lib/bindings";
import { useScrollMargin } from "@/lib/hooks/use-scroll-margin";
import { eventPageOptions } from "@/lib/queries";
import { hasTimestamp, duration } from "@/lib/format";
import { cn } from "cn";
import { toolPreview, type Snippet } from "@/lib/session/tool-preview";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { ErrorNotice } from "./page";
import { Highlight } from "./highlight";
import { Markdown } from "./markdown";

const estimate = (kind: string) =>
  kind === "tool" ? 40 : kind === "user" || kind === "assistant" ? 240 : 48;

export type SessionLogHandle = {
  jumpTo: (index: number, focus?: boolean) => void;
};

export function SessionLog({
  id,
  cwd,
  timeline,
  view,
  initialPosition,
  onPosition,
  scrollRef,
  ref,
}: {
  id: string;
  cwd: string;
  timeline: TimelineSummary;
  view: { kind: "all" } | { kind: "search"; query: string; firstPage: EventPage };
  initialPosition: { index: number; focus: boolean };
  onPosition: (index: number) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  ref: Ref<SessionLogHandle>;
}) {
  "use no memo";
  const container = useRef<HTMLDivElement>(null);
  const margin = useScrollMargin(container, scrollRef);
  const [jump, setJump] = useState(() => ({
    ...initialPosition,
    scroll: initialPosition.focus || initialPosition.index > 0,
    index:
      view.kind === "search"
        ? Math.max(0, view.firstPage.matches.indexOf(initialPosition.index))
        : initialPosition.index,
  }));
  const completedJump = useRef<typeof jump | null>(null);
  const [expanded, setExpanded] = useState<Map<number, boolean>>(() => new Map());
  const search = view.kind === "search" ? view.query : "";
  const exactKinds = useMemo(
    () =>
      new Map(
        timeline.marks.filter((mark) => mark.count === 1).map((mark) => [mark.index, mark.kind]),
      ),
    [timeline],
  );
  const averageHeight = useMemo(
    () =>
      timeline.marks.reduce((sum, mark) => sum + estimate(mark.kind) * mark.count, 0) /
      Math.max(1, timeline.count),
    [timeline],
  );
  const count = view.kind === "search" ? view.firstPage.total : timeline.count;
  // Virtual owns a mutable viewport instance. Keep this component outside React Compiler.
  // oxlint-disable-next-line react/incompatible-library
  const virtual = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => index,
    estimateSize: (index) => {
      const kind = search ? undefined : exactKinds.get(index);
      return search ? 240 : kind ? estimate(kind) : averageHeight;
    },
    // Apply measured row heights outside the ResizeObserver delivery cycle.
    useAnimationFrameWithResizeObserver: true,
    // Page recovery can change the scroll margin during the virtualizer's own
    // layout effect. Let React batch that update instead of nesting flushSync.
    useFlushSync: false,
    overscan: 8,
    gap: 8,
    scrollMargin: margin ?? 0,
    // The session navigation (56px) and transcript toolbar (64px), plus a small gap.
    scrollPaddingStart: 128,
  });
  const items = virtual.getVirtualItems();
  const offsets = [...new Set(items.map((item) => Math.floor(item.index / 100) * 100))];
  const pages = useQueries({
    queries: offsets
      .filter((offset) => view.kind === "all" || offset !== 0)
      .map((offset) => eventPageOptions(id, search, offset)),
  });
  const byOffset = new Map(
    pages.flatMap((page) => (page.data ? [[page.data.offset, page.data] as const] : [])),
  );
  if (view.kind === "search") byOffset.set(0, view.firstPage);
  const failed = pages.find((page) => page.error);
  const target = Math.max(0, Math.min(jump.index, count - 1));
  const targetPage = byOffset.get(Math.floor(target / 100) * 100);
  const targetLoaded = !!targetPage?.events[target - targetPage.offset];
  const targetRendered = items.some((item) => item.index === target);

  useImperativeHandle(ref, () => ({
    jumpTo: (index, focus = true) => setJump({ index, focus, scroll: true }),
  }));
  useLayoutEffect(() => {
    if (margin === null || !count || completedJump.current === jump) return;
    // Scrolling may synchronously notify the virtualizer. Run it after React's
    // layout effects so that notification can render the target without nesting
    // flushSync inside an active React commit.
    const frame = requestAnimationFrame(() => {
      if (jump.scroll) virtual.scrollToIndex(target, { align: "start" });
      if (!targetLoaded || !targetRendered) return;
      const element = container.current?.querySelector<HTMLElement>(`[data-index="${target}"]`);
      if (jump.focus) element?.focus({ preventScroll: true });
      completedJump.current = jump;
      const originalIndex = search ? targetPage?.matches[target - targetPage.offset] : target;
      if (originalIndex !== undefined) onPosition(originalIndex);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    virtual,
    margin,
    count,
    jump,
    target,
    targetLoaded,
    targetRendered,
    search,
    targetPage,
    onPosition,
  ]);

  useLayoutEffect(() => {
    if (completedJump.current !== jump) return;
    const edge = (scrollRef.current?.scrollTop ?? 0) + 128;
    const visible = items.find((item) => item.start + item.size > edge);
    if (!visible) return;
    const page = byOffset.get(Math.floor(visible.index / 100) * 100);
    if (!page) return;
    const index = search ? page.matches[visible.index - page.offset] : visible.index;
    if (index !== undefined) onPosition(index);
  });

  return (
    <div role="region" aria-label="Session conversation">
      {failed?.error && (
        <div className="sticky top-40 z-20">
          <ErrorNotice error={failed.error} retry={() => void failed.refetch()} />
        </div>
      )}
      <div
        ref={container}
        className="relative [overflow-anchor:none]"
        style={{ height: virtual.getTotalSize() }}
        aria-busy={pages.some((page) => page.isPending)}
      >
        {items.map((item) => {
          const page = byOffset.get(Math.floor(item.index / 100) * 100);
          const event = page?.events[item.index - page.offset];
          const index = search
            ? (page?.matches[item.index - page.offset] ?? item.index)
            : item.index;
          return (
            <div
              key={item.key}
              ref={virtual.measureElement}
              data-index={item.index}
              data-event-index={index}
              tabIndex={-1}
              className={cn(
                "absolute top-0 left-0 w-full rounded-xl",
                jump.focus && item.index === target && "ring-1 ring-primary/35",
              )}
              style={{ transform: `translateY(${item.start - (margin ?? 0)}px)` }}
            >
              {event ? (
                <Event
                  event={event}
                  cwd={cwd}
                  search={search}
                  expanded={
                    expanded.get(index) ??
                    ((Boolean(search) && event.kind !== "tool") ||
                      (jump.focus && item.index === target))
                  }
                  onExpandedChange={(open) =>
                    setExpanded((previous) => {
                      if (previous.get(index) === open) return previous;
                      return new Map(previous).set(index, open);
                    })
                  }
                />
              ) : (
                <Skeleton
                  className="w-full rounded-xl"
                  style={{ height: item.size }}
                  aria-label="Loading event"
                />
              )}
            </div>
          );
        })}
      </div>
      {count === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {search ? "No matching events." : "No events have been recorded yet."}
        </p>
      )}
    </div>
  );
}

const toolIcons = { command: Terminal, file: FileText, search: Search, other: Wrench };

function PreviewText({ value }: { value: Snippet | null }) {
  if (!value) return null;
  const { text, match } = value;
  return match ? (
    <>
      {text.slice(0, match.start)}
      <mark className="rounded-sm bg-primary/20 text-foreground">
        {text.slice(match.start, match.end)}
      </mark>
      {text.slice(match.end)}
    </>
  ) : (
    text
  );
}

function ToolCall({
  event,
  cwd,
  search,
  expanded,
  onExpandedChange,
}: {
  event: SessionEvent;
  cwd: string;
  search: string;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
}) {
  // Scrolling re-renders visible rows. Parse and search their potentially large inputs only when they change.
  const preview = useMemo(() => toolPreview(event, cwd, search), [event, cwd, search]);
  const excerpt =
    preview.output ?? (preview.input?.match ? preview.input : (preview.error ?? preview.input));
  const Icon = toolIcons[preview.kind];
  return (
    <details
      open={expanded}
      onToggle={(event) => onExpandedChange(event.currentTarget.open)}
      className="group rounded-xl bg-card"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 text-xs hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <Icon className="size-3.5 shrink-0 text-chart-2" />
        <span
          className={cn(
            "min-w-0 truncate font-mono",
            !expanded && excerpt ? "max-w-[40%] shrink-0" : "flex-1",
          )}
          title={event.tool ?? undefined}
        >
          <PreviewText value={preview.name} />
        </span>
        {!expanded && excerpt && (
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground",
              excerpt === preview.error && "text-destructive",
            )}
          >
            {excerpt === preview.output && <span className="font-sans">Result · </span>}
            <PreviewText value={excerpt} />
          </span>
        )}
        {event.failed === true && <span className="shrink-0 text-destructive">Failed</span>}
        {event.output == null && (
          <span className="shrink-0 text-muted-foreground">No result recorded</span>
        )}
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {duration(event.durationMs)}
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground group-open:rotate-90" />
      </summary>
      <div className="space-y-4 px-4 pt-1 pb-4">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">INPUT</p>
            <CopyPayload text={event.text} label="Copy tool input" />
          </div>
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-background/70 p-3 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
            <Highlight text={event.text} search={search} />
          </pre>
        </div>
        {event.output != null && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">RESULT</p>
              <CopyPayload text={event.output} label="Copy tool result" />
            </div>
            <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-background/70 p-3 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
              <Highlight text={event.output} search={search} />
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function Event({
  event,
  cwd,
  search,
  expanded,
  onExpandedChange,
}: {
  event: SessionEvent;
  cwd: string;
  search: string;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
}) {
  if (event.kind === "tool")
    return (
      <ToolCall
        event={event}
        cwd={cwd}
        search={search}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
      />
    );
  if (event.kind === "thinking" || event.kind === "compaction")
    return (
      <details
        open={expanded}
        onToggle={(event) => onExpandedChange(event.currentTarget.open)}
        className="rounded-xl px-4 py-3"
      >
        <summary className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          {event.kind === "thinking" ? (
            <Brain className="size-3.5" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}
          {event.kind === "thinking" ? "Recorded thinking summary" : "Context compacted"}
        </summary>
        <div className="mt-3">
          <Markdown text={event.text || "No summary was recorded."} search={search} />
        </div>
      </details>
    );
  return <Message event={event} search={search} />;
}

function Message({ event, search }: { event: SessionEvent; search: string }) {
  const copy = useMutation({
    mutationFn: () => navigator.clipboard.writeText(event.text),
    onSuccess: () => toast.success("Copied to clipboard"),
  });
  return (
    <article className={event.kind === "user" ? "rounded-xl bg-card p-5" : "px-5 py-4"}>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs font-medium">{event.kind === "user" ? "You" : "Assistant"}</span>
        <time
          className="text-[11px] text-muted-foreground"
          dateTime={
            hasTimestamp(event.timestamp) ? new Date(event.timestamp).toISOString() : undefined
          }
          title={
            hasTimestamp(event.timestamp)
              ? format(event.timestamp, "MMM d, yyyy · HH:mm:ss xxx")
              : undefined
          }
        >
          {hasTimestamp(event.timestamp) ? format(event.timestamp, "HH:mm:ss") : "Time unknown"}
        </time>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          aria-label="Copy message"
          onClick={() => copy.mutate()}
        >
          <Copy />
        </Button>
      </div>
      <Markdown text={event.text} search={search} />
    </article>
  );
}

function CopyPayload({ text, label }: { text: string; label: string }) {
  const copy = useMutation({
    mutationFn: () => navigator.clipboard.writeText(text),
    onSuccess: () => toast.success("Copied to clipboard"),
  });
  return (
    <Button variant="ghost" size="icon-xs" aria-label={label} onClick={() => copy.mutate()}>
      <Copy />
    </Button>
  );
}
