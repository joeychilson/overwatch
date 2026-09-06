import { useMemo, useState } from "react";
import type { EventKind, TimelineEvent } from "@/lib/bindings";
import { duration, hasTimestamp } from "@/lib/format";

const lanes: { kind: EventKind; label: string; color: string }[] = [
  { kind: "user", label: "You", color: "var(--chart-4)" },
  { kind: "assistant", label: "Assistant", color: "var(--chart-1)" },
  { kind: "thinking", label: "Thinking", color: "var(--chart-3)" },
  { kind: "tool", label: "Tools", color: "var(--chart-2)" },
  { kind: "compaction", label: "Compaction", color: "var(--chart-5)" },
];
const width = 1000,
  labelWidth = 4,
  plotWidth = width - labelWidth - 8;
export function Timeline({
  events,
  selected,
  onSelect,
}: {
  events: TimelineEvent[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // A transcript can contain tens of thousands of events. Pointer movement should
  // only look up a timestamp, never rebuild the SVG paths.
  const { start, end, paths, ordered, undated } = useMemo(() => {
    const undated = events.filter((event) => !hasTimestamp(event.timestamp)).length;
    const position = (event: TimelineEvent, index: number) => (undated ? index : event.timestamp);
    let start = Infinity,
      end = 0;
    events.forEach((event, index) => {
      start = Math.min(start, position(event, index));
      end = Math.max(end, position(event, index) + (undated ? 0 : (event.durationMs ?? 0)));
    });
    if (!events.length) start = 0;
    end = Math.max(start + 1, end);
    const paths = new Map<EventKind, string[]>();
    events.forEach((event, index) => {
      const lane = lanes.findIndex((lane) => lane.kind === event.kind);
      const parts = paths.get(event.kind) ?? [];
      parts.push(
        `M${(labelWidth + ((position(event, index) - start) / (end - start)) * plotWidth).toFixed(1)},${lane * 25 + 12}h${Math.max(1.8, ((undated ? 0 : (event.durationMs ?? 0)) / (end - start)) * plotWidth).toFixed(1)}`,
      );
      paths.set(event.kind, parts);
    });
    return {
      start,
      end,
      undated,
      paths: new Map([...paths].map(([kind, parts]) => [kind, parts.join(" ")])),
      ordered: events
        .map((event, index) => ({ timestamp: position(event, index), index }))
        .sort((a, b) => a.timestamp - b.timestamp),
    };
  }, [events]);
  if (!events.length) return null;
  const x = (time: number) =>
    labelWidth + ((time - start) / (end - start)) * (width - labelWidth - 8);
  const inspected = events[Math.min(hover ?? selected, events.length - 1)];
  const inspectedIndex = Math.min(hover ?? selected, events.length - 1);
  const timing = undated ? "event order" : `${duration(inspected.timestamp - start)} from start`;
  function nearest(time: number) {
    let low = 0,
      high = ordered.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ordered[middle].timestamp < time) low = middle + 1;
      else high = middle;
    }
    const previous = Math.max(0, low - 1);
    return ordered[
      Math.abs(ordered[previous].timestamp - time) < Math.abs(ordered[low].timestamp - time)
        ? previous
        : low
    ].index;
  }
  return (
    <div className="py-2">
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="flex h-36 w-20 shrink-0 flex-col justify-around text-xs text-muted-foreground"
        >
          {lanes.map((lane) => (
            <span key={lane.kind}>{lane.label}</span>
          ))}
        </div>
        <svg
          viewBox="0 0 1000 125"
          preserveAspectRatio="none"
          className="h-36 min-w-0 flex-1 overflow-visible rounded"
          role="slider"
          tabIndex={0}
          aria-label="Session activity timeline"
          aria-valuemin={1}
          aria-valuemax={events.length}
          aria-valuenow={Math.min(selected + 1, events.length)}
          aria-valuetext={`${inspected.kind}, event ${inspected.index + 1}, ${timing}`}
          onKeyDown={(event) => {
            let next: number;
            switch (event.key) {
              case "ArrowRight":
                next = Math.min(events.length - 1, selected + 1);
                break;
              case "ArrowLeft":
                next = Math.max(0, selected - 1);
                break;
              case "Home":
                next = 0;
                break;
              case "End":
                next = events.length - 1;
                break;
              default:
                return;
            }
            event.preventDefault();
            onSelect(next);
          }}
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setHover(
              nearest(
                start +
                  ((((event.clientX - box.left) / box.width) * width - labelWidth) /
                    (width - labelWidth - 8)) *
                    (end - start),
              ),
            );
          }}
          onPointerLeave={() => setHover(null)}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onSelect(
              nearest(
                start +
                  ((((event.clientX - box.left) / box.width) * width - labelWidth) /
                    (width - labelWidth - 8)) *
                    (end - start),
              ),
            );
          }}
        >
          {lanes.map((lane) => (
            <path
              key={lane.kind}
              d={paths.get(lane.kind)}
              stroke={lane.color}
              strokeWidth="6"
              strokeLinecap="round"
            />
          ))}
          <line
            x1={x(undated ? inspectedIndex : inspected.timestamp)}
            x2={x(undated ? inspectedIndex : inspected.timestamp)}
            y1="0"
            y2="126"
            stroke="var(--foreground)"
            strokeOpacity="0.5"
            strokeDasharray="3 3"
          />
        </svg>
      </div>
      <div className="mt-2 ml-23 flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{undated ? "Event 1" : "0s"}</span>
        <span>{undated ? `Event ${events.length}` : duration(end - start)}</span>
      </div>
      {undated > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Shown in event order because {undated} {undated === 1 ? "event has" : "events have"} no
          usable timestamp. Spacing does not represent elapsed time. All events remain available.
        </p>
      )}
      <p className="mt-2 h-4 truncate text-[11px] text-muted-foreground">
        {inspected.tool ?? lanes.find((lane) => lane.kind === inspected.kind)?.label} · event{" "}
        {inspected.index + 1} · {timing}
        {inspected.durationMs != null ? ` · ${duration(inspected.durationMs)} elapsed` : ""}
        {inspected.failed ? " · Failed" : ""}
      </p>
    </div>
  );
}
