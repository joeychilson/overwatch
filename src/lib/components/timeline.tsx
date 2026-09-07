import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EventKind, TimelineSummary } from "@/lib/bindings";
import { duration } from "@/lib/format";
import { eventPageOptions } from "@/lib/queries";

const lanes: { kind: EventKind; label: string; color: string }[] = [
  { kind: "user", label: "You", color: "var(--chart-4)" },
  { kind: "assistant", label: "Assistant", color: "var(--chart-1)" },
  { kind: "thinking", label: "Thinking", color: "var(--chart-3)" },
  { kind: "tool", label: "Tools", color: "var(--chart-2)" },
  { kind: "compaction", label: "Compaction", color: "var(--chart-5)" },
];
const width = 1000,
  labelWidth = 4,
  plotWidth = 988;
export function Timeline({
  id,
  overview,
  selected,
  onSelect,
}: {
  id: string;
  overview: TimelineSummary;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const { marks, count, start, end, undated } = overview;
  const current = Math.max(0, Math.min(selected, count - 1));
  // Share the exact event page with the reader; overview marks never determine
  // the number of messages or limit keyboard access to an original event.
  const page = useQuery({
    ...eventPageOptions(id, "", Math.floor(current / 100) * 100),
    enabled: count > 0,
  });
  const event = page.data?.events[current - page.data.offset];
  const x = (at: number) => labelWidth + ((at - start) / Math.max(1, end - start)) * plotWidth;
  const { paths, ordered } = useMemo(() => {
    const paths = new Map<EventKind, string[]>();
    for (const mark of marks) {
      const parts = paths.get(mark.kind) ?? [];
      parts.push(
        `M${(labelWidth + ((mark.start - start) / Math.max(1, end - start)) * plotWidth).toFixed(1)},${lanes.findIndex((lane) => lane.kind === mark.kind) * 25 + 12}h${Math.max(1.8, ((mark.end - mark.start) / Math.max(1, end - start)) * plotWidth).toFixed(1)}`,
      );
      paths.set(mark.kind, parts);
    }
    return {
      paths: new Map([...paths].map(([kind, parts]) => [kind, parts.join(" ")])),
      ordered: marks.map((mark, index) => ({ at: mark.start, index })).sort((a, b) => a.at - b.at),
    };
  }, [marks, start, end]);
  if (!count || !marks.length) return null;
  function nearest(at: number) {
    let low = 0,
      high = ordered.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ordered[middle].at < at) low = middle + 1;
      else high = middle;
    }
    const previous = Math.max(0, low - 1);
    return ordered[
      Math.abs(ordered[previous].at - at) < Math.abs(ordered[low].at - at) ? previous : low
    ].index;
  }
  const nearSelected = marks.reduce(
    (best, mark) => (Math.abs(mark.index - current) < Math.abs(best.index - current) ? mark : best),
    marks[0],
  );
  const inspected = hover === null ? null : marks[hover];
  const at = inspected?.start ?? (undated ? current : (event?.timestamp ?? nearSelected.start));
  const timing = undated
    ? "event order"
    : `${duration((event?.timestamp ?? nearSelected.start) - start)} from start`;
  const pointerMark = (element: SVGSVGElement, clientX: number) => {
    const box = element.getBoundingClientRect();
    return nearest(
      start +
        ((((clientX - box.left) / box.width) * width - labelWidth) / plotWidth) * (end - start),
    );
  };
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
          aria-valuemax={count}
          aria-valuenow={current + 1}
          aria-valuetext={`${event?.kind ?? nearSelected.kind}, event ${current + 1}, ${timing}`}
          onKeyDown={(event) => {
            let next: number;
            switch (event.key) {
              case "ArrowRight":
                next = current + 1;
                break;
              case "ArrowLeft":
                next = current - 1;
                break;
              case "PageDown":
                next = current + 100;
                break;
              case "PageUp":
                next = current - 100;
                break;
              case "Home":
                next = 0;
                break;
              case "End":
                next = count - 1;
                break;
              default:
                return;
            }
            event.preventDefault();
            setHover(null);
            onSelect(Math.max(0, Math.min(count - 1, next)));
          }}
          onPointerMove={(event) => setHover(pointerMark(event.currentTarget, event.clientX))}
          onPointerLeave={() => setHover(null)}
          onClick={(event) => {
            onSelect(marks[pointerMark(event.currentTarget, event.clientX)].index);
            setHover(null);
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
            x1={x(at)}
            x2={x(at)}
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
        <span>{undated ? `Event ${count}` : duration(end - start)}</span>
      </div>
      {undated > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Shown in event order because {undated} {undated === 1 ? "event has" : "events have"} no
          usable timestamp. Spacing does not represent elapsed time. All events remain available.
        </p>
      )}
      <p className="mt-2 h-4 truncate text-[11px] text-muted-foreground">
        {inspected ? (
          <>
            {lanes.find((lane) => lane.kind === inspected.kind)?.label} ·{" "}
            {inspected.count === 1
              ? `event ${inspected.index + 1}`
              : `${inspected.count} nearby events`}
            {inspected.failures > 0 ? ` · ${inspected.failures} failed` : ""}
          </>
        ) : (
          <>
            {event?.tool ??
              lanes.find((lane) => lane.kind === (event?.kind ?? nearSelected.kind))?.label}{" "}
            · event {current + 1} · {timing}
            {event?.durationMs != null ? ` · ${duration(event.durationMs)} elapsed` : ""}
            {event?.failed ? " · Failed" : ""}
          </>
        )}
      </p>
    </div>
  );
}
