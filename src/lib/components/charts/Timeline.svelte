<script lang="ts">
  /**
   * When a session's turns happened, in lanes for the person, the agent, and
   * its tools.
   *
   * A pause longer than `IDLE` is cut out of the axis and marked, so a session
   * picked up again days later still spends its width on the work. Where the
   * source records no times, turns are spaced in order instead.
   *
   * Pointing reads out the nearest turn in the lane under the pointer, and
   * choosing it brings that turn into view in the conversation. The arrow keys
   * step through what was said.
   */
  import type { Agent, Mark, Speaker } from "#lib/api/backend.ts";
  import { agentDisplay } from "#lib/agents.ts";
  import { formatDay, formatTime } from "#lib/format.ts";
  import { startOfDay } from "#lib/periods.ts";
  import { IDLE } from "#lib/transcript.ts";

  interface Props {
    marks: readonly Mark[];
    agent: Agent;
    /** Called with the index of the turn chosen. */
    onselect: (index: number) => void;
  }

  let { marks, agent, onselect }: Props = $props();

  /** Pixels: the lane names, a lane, the space between lanes, and the times beneath. */
  const GUTTER = 48;
  const LANE = 10;
  const SPACE = 6;
  const FOOT = 20;
  /** The pixels a pause longer than `IDLE` is cut down to. */
  const CUT = 14;
  /** The least time a stretch of activity is drawn as, so none is too thin to point at. */
  const LEAST = 60_000;
  /** Width in pixels of the card that reads out a turn. */
  const CARD = 280;

  const LANES = ["You", "Agent", "Tools"] as const;
  const PLOT = LANES.length * (LANE + SPACE) - SPACE;
  const HEIGHT = PLOT + FOOT;

  function laneOf(speaker: Speaker) {
    return speaker === "user" ? 0 : speaker === "tool" ? 2 : 1;
  }

  let width = $state(0);
  /** The position in `points` being read out, if any. */
  let active = $state<number | null>(null);

  const colors = $derived(["var(--text)", agentDisplay(agent).color, "var(--muted)"]);

  /** Each turn in a lane, drawn at its own time or the latest recorded before it. */
  const timed = $derived.by(() => {
    const drawn = marks.filter((mark) => mark.speaker !== "system");
    let last = drawn.find((mark) => mark.at !== null)?.at ?? null;
    return drawn.map((mark) => {
      last = mark.at ?? last;
      return { mark, at: last, lane: laneOf(mark.speaker) };
    });
  });

  /** The stretches of activity the axis shows, and where each is drawn. */
  const stretches = $derived.by(() => {
    const times = timed.flatMap((turn) => (turn.at === null ? [] : [turn.at]));
    const found: { start: number; end: number }[] = [];
    for (const at of times.sort((a, b) => a - b)) {
      const current = found.at(-1);
      if (current && at - current.end <= IDLE) current.end = at;
      else found.push({ start: at, end: at });
    }
    const cuts = Math.max(0, found.length - 1);
    const cut = cuts === 0 ? 0 : Math.min(CUT, ((width - GUTTER) * 0.3) / cuts);
    const spans = found.map((stretch) => Math.max(LEAST, stretch.end - stretch.start));
    const scale = (width - GUTTER - cut * cuts) / spans.reduce((sum, span) => sum + span, 0);
    let x = GUTTER;
    return found.map((stretch, order) => {
      const span = spans[order] ?? LEAST;
      const laid = { ...stretch, span, x, px: span * scale };
      x += laid.px + cut;
      return laid;
    });
  });

  const points = $derived(
    timed.map((turn, order) => {
      const at = turn.at;
      if (at === null || stretches.length === 0) {
        return { ...turn, x: GUTTER + ((width - GUTTER) * (order + 0.5)) / timed.length };
      }
      const stretch = stretches.reduce((found, candidate) =>
        candidate.start <= at ? candidate : found,
      );
      return { ...turn, x: stretch.x + ((at - stretch.start) / stretch.span) * stretch.px };
    }),
  );

  /** Turns gathered into columns three pixels wide, lane by lane. */
  const columns = $derived.by(() => {
    const found = new Map<string, { lane: number; x: number; count: number; failed: boolean }>();
    for (const point of points) {
      const x = Math.floor(point.x / 3) * 3;
      const key = `${point.lane}:${x}`;
      const column = found.get(key) ?? { lane: point.lane, x, count: 0, failed: false };
      column.count += 1;
      column.failed ||= point.mark.failed;
      found.set(key, column);
    }
    return [...found];
  });

  const multiday = $derived(
    startOfDay(stretches[0]?.start ?? 0) !== startOfDay(stretches.at(-1)?.end ?? 0),
  );

  /** Times beneath the lanes: where each stretch starts, as room allows, and where the last ends. */
  const labels = $derived.by(() => {
    const placed: { x: number; text: string; anchor: "start" | "end" }[] = [];
    let reach = 0;
    let day: number | null = null;
    for (const stretch of stretches) {
      if (stretch.x < reach) continue;
      const today = startOfDay(stretch.start);
      const text =
        multiday && today !== day
          ? `${formatDay(stretch.start)}, ${formatTime(stretch.start)}`
          : formatTime(stretch.start);
      placed.push({ x: stretch.x, text, anchor: "start" });
      reach = stretch.x + text.length * 6.5 + 16;
      day = today;
    }
    const last = stretches.at(-1);
    if (last && width - formatTime(last.end).length * 6.5 >= reach) {
      placed.push({ x: width, text: formatTime(last.end), anchor: "end" });
    }
    return placed;
  });

  /** Positions of what the person and the model said, which the arrow keys step through. */
  const said = $derived(
    points.flatMap((point, position) =>
      point.mark.speaker === "user" || point.mark.speaker === "assistant" ? [position] : [],
    ),
  );

  const reading = $derived(active === null ? undefined : points[active]);

  function who(mark: Mark) {
    if (mark.speaker === "user") return "You";
    if (mark.speaker === "assistant") return agentDisplay(agent).name;
    if (mark.speaker === "reasoning") return "Thinking";
    return mark.label;
  }

  function when(at: number | null) {
    if (at === null) return "";
    return multiday ? `${formatDay(at)}, ${formatTime(at)}` : formatTime(at);
  }

  function describe(point: (typeof points)[number] | undefined) {
    if (!point) return "";
    const { mark } = point;
    const spoken = mark.speaker === "user" || mark.speaker === "assistant";
    const parts = [spoken ? `${who(mark)}: ${mark.label}` : who(mark)];
    if (mark.failed) parts.push("failed");
    if (point.at !== null) parts.push(when(point.at));
    return parts.join(", ");
  }

  function pointAt(event: PointerEvent & { currentTarget: SVGSVGElement }) {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const row = Math.floor((event.clientY - box.top) / (LANE + SPACE));
    // Below the lanes, the nearest turn in any lane.
    const lane = row < LANES.length ? row : null;
    let nearest: number | null = null;
    let distance = Infinity;
    for (const [position, point] of points.entries()) {
      if (lane !== null && point.lane !== lane) continue;
      if (Math.abs(point.x - x) < distance) {
        distance = Math.abs(point.x - x);
        nearest = position;
      }
    }
    active = nearest;
  }

  function step(event: KeyboardEvent) {
    if ((event.key === "Enter" || event.key === " ") && reading) {
      event.preventDefault();
      onselect(reading.mark.index);
      return;
    }
    const from = active;
    const current = from === null ? -1 : said.filter((position) => position <= from).length - 1;
    const moves: Partial<Record<string, number>> = {
      ArrowLeft: current - 1,
      ArrowRight: current + 1,
      Home: 0,
      End: said.length - 1,
    };
    const to = moves[event.key];
    if (to === undefined) return;
    event.preventDefault();
    active = said[Math.max(0, Math.min(said.length - 1, to))] ?? null;
  }
</script>

<div class="relative" bind:clientWidth={width}>
  {#if width > 0}
    <svg
      class="block cursor-pointer overflow-visible select-none"
      {width}
      height={HEIGHT}
      role="slider"
      tabindex="0"
      aria-label="Timeline"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, marks.length - 1)}
      aria-valuenow={reading?.mark.index ?? 0}
      aria-valuetext={describe(reading)}
      onpointermove={pointAt}
      onpointerleave={() => (active = null)}
      onfocus={() => (active ??= said.at(-1) ?? null)}
      onblur={() => (active = null)}
      onkeydown={step}
      onclick={() => {
        if (reading) onselect(reading.mark.index);
      }}
    >
      {#each LANES as name, lane (name)}
        <text class="fill-muted text-[11px]" x={0} y={lane * (LANE + SPACE) + LANE / 2} dy="0.35em">
          {name}
        </text>
      {/each}

      {#each stretches as stretch, order (stretch.start)}
        {@const before = stretches[order - 1]}
        {#if before}
          {@const x = (before.x + before.px + stretch.x) / 2}
          <line class="stroke-border" x1={x} x2={x} y1={0} y2={PLOT} stroke-dasharray="2 3" />
        {/if}
      {/each}

      {#each columns as [key, column] (key)}
        <rect
          x={column.x}
          y={column.lane * (LANE + SPACE)}
          width={2}
          height={LANE}
          rx={1}
          style:fill={column.failed ? "var(--danger)" : colors[column.lane]}
          style:opacity={Math.min(1, 0.4 + column.count * 0.2)}
        />
      {/each}

      {#if reading}
        <line class="stroke-(--focus)" x1={reading.x} x2={reading.x} y1={-3} y2={PLOT + 3} />
      {/if}

      {#each labels as label (`${label.x}:${label.text}`)}
        <text
          class="fill-muted text-[11px] tabular-nums"
          x={label.x}
          y={HEIGHT - 4}
          text-anchor={label.anchor}>{label.text}</text
        >
      {/each}
    </svg>
  {/if}

  {#if reading}
    <div
      class="pointer-events-none absolute z-10 grid gap-1 rounded-menu border border-border bg-menu px-3 py-2 text-meta shadow-lg"
      style:left="{Math.max(0, Math.min(width - CARD, reading.x - CARD / 2))}px"
      style:top="{HEIGHT + 6}px"
      style:width="{CARD}px"
      aria-hidden="true"
    >
      <p class="flex gap-3 text-muted">
        <span class="min-w-0 truncate">{who(reading.mark)}</span>
        <span class="ml-auto shrink-0 tabular-nums">{when(reading.at)}</span>
      </p>
      {#if reading.mark.speaker === "user" || reading.mark.speaker === "assistant"}
        <p class="line-clamp-3 wrap-anywhere">{reading.mark.label}</p>
      {/if}
      {#if reading.mark.failed}
        <p class="text-danger">Failed</p>
      {/if}
    </div>
  {/if}
</div>
