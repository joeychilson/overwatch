import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
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
import type { SessionEvent } from "@/lib/bindings";
import { hasTimestamp, duration } from "@/lib/format";
import { cn } from "cn";
import { toolPreview, type Snippet } from "@/lib/session/tool-preview";
import { Button } from "./ui/button";
import { Highlight } from "./highlight";
import { Markdown } from "./markdown";

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
      {expanded && (
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
      )}
    </details>
  );
}

export function SessionEventView({
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
        {expanded && (
          <div className="mt-3">
            <Markdown text={event.text || "No summary was recorded."} search={search} />
          </div>
        )}
      </details>
    );
  return <Message event={event} search={search} />;
}

function Message({ event, search }: { event: SessionEvent; search: string }) {
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
        <CopyPayload text={event.text} label="Copy message" className="ml-auto" />
      </div>
      <Markdown text={event.text} search={search} />
    </article>
  );
}

function CopyPayload({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const copy = useMutation({
    mutationFn: () => navigator.clipboard.writeText(text),
    onSuccess: () => toast.success("Copied to clipboard"),
  });
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={className}
      aria-label={label}
      onClick={() => copy.mutate()}
    >
      <Copy />
    </Button>
  );
}
