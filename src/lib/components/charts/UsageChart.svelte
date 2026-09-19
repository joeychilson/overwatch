<script lang="ts">
  /**
   * Usage across a period, a column per day stacked by agent, or per hour when
   * the period is a single day and its hours are given.
   *
   * Every day of the period has a column, idle ones included, so a quiet week
   * reads as quiet instead of vanishing, and so does every hour of a day, those
   * still to come included. A long period is drawn a week to a column, which
   * keeps each one wide enough to point at.
   *
   * The chart is one slider: pointing at a column, or moving along with the
   * arrow keys, reads that column out, in a card and to assistive technology.
   * Clicking a column, or pressing Enter on it, opens the sessions that used
   * tokens in its hour, day or week. With no usage at all it keeps its frame
   * and says why it is empty.
   */
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import type { Agent, AgentDay, DayTotals, HourTotals } from "#lib/api/backend.ts";
  import { agentDisplay } from "#lib/agents.ts";
  import { formatDay, formatHour, formatHours, formatMeasure, type Measure } from "#lib/format.ts";
  import { addDays, dayKey } from "#lib/periods.ts";
  import { columns, hours as hourColumns } from "./columns.ts";
  import { tickLabel, ticks } from "./ticks.ts";

  interface Props {
    days: readonly DayTotals[];
    /** The day's usage by the hour, which draws the day an hour to a column. */
    hours?: readonly HourTotals[];
    /** Local midnight when the period began; unset for all of history. */
    since: number | undefined;
    measure: Measure;
    /** What to say when the period has no usage. */
    empty: string;
  }

  let { days, hours, since, measure, empty }: Props = $props();

  /** Heights in pixels: the whole chart, the dates beneath it, and headroom above. */
  const HEIGHT = 208;
  const FOOT = 24;
  const TOP = 6;
  /** Width in pixels of the value labels left of the columns. */
  const GUTTER = 44;
  /** Width in pixels of the card that reads out a column. */
  const CARD = 196;

  interface Column {
    start: number;
    /** Each agent's usage; null for one whose usage has no price. */
    values: Map<Agent, number | null>;
    /** Null when the column has no usage, or none of it is priced. */
    total: number | null;
  }

  let width = $state(0);
  /** The column being read out, if any. */
  let active = $state<number | null>(null);

  /** A running sum in which null is unknown: it stays unknown only until a number arrives. */
  function add(sum: number | null | undefined, value: number | null): number | null {
    return value === null ? (sum ?? null) : (sum ?? 0) + value;
  }

  const chart = $derived.by(() => {
    const laid = hours
      ? hourColumns(since ?? Date.now())
      : columns(since ?? days[0]?.day ?? Date.now());
    const spans: { start: number; byAgent: AgentDay[] }[] = hours
      ? hours.map((hour) => ({ start: hour.hour, byAgent: hour.byAgent }))
      : days.map((day) => ({ start: day.day, byAgent: day.byAgent }));
    const drawn: Column[] = laid.starts.map((start) => ({ start, values: new Map(), total: null }));
    for (const span of spans) {
      const column = drawn[laid.of(span.start) ?? -1];
      if (!column) continue;
      for (const share of span.byAgent) {
        const value = measure === "cost" ? share.costUsd : share.tokens;
        column.values.set(share.agent, add(column.values.get(share.agent), value));
        column.total = add(column.total, value);
      }
    }
    // Largest first: at the foot of every stack, and at the head of the legend.
    const totals = new Map<Agent, number | null>();
    for (const column of drawn) {
      for (const [agent, value] of column.values) totals.set(agent, add(totals.get(agent), value));
    }
    const agents = [...totals].sort(([, a], [, b]) => (b ?? 0) - (a ?? 0));
    return { columns: drawn, grain: laid.grain, agents };
  });

  const used = $derived(chart.agents.length > 0);
  const axis = $derived(
    used
      ? ticks(Math.max(0, ...chart.columns.map((column) => column.total ?? 0)))
      : [0, 1, 2, 3, 4],
  );
  const band = $derived((width - GUTTER) / chart.columns.length);
  const thickness = $derived(Math.min(28, band * 0.75));

  function y(value: number) {
    return TOP + (HEIGHT - FOOT - TOP) * (1 - value / (axis.at(-1) ?? 1));
  }

  /** A rectangle as a path, its top corners rounded by `radius`. */
  function segment(x: number, top: number, width: number, height: number, radius: number) {
    const r = Math.min(radius, width / 2, height);
    return `M${x},${top + height}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${top + height}Z`;
  }

  /** The agents with usage in a column, in the chart's order. */
  function present(column: Column): Agent[] {
    return chart.agents.flatMap(([agent]) => (column.values.has(agent) ? [agent] : []));
  }

  const stacks = $derived(
    chart.columns.map((column, index) => {
      const x = GUTTER + index * band + (band - thickness) / 2;
      const drawn = present(column).filter((agent) => (column.values.get(agent) ?? 0) > 0);
      let sum = 0;
      return drawn.map((agent, order) => {
        const value = column.values.get(agent) ?? 0;
        const top = y(sum + value);
        const path = segment(x, top, thickness, y(sum) - top, order === drawn.length - 1 ? 2 : 0);
        sum += value;
        return { agent, path };
      });
    }),
  );

  /**
   * The columns that carry a label, as room allows: the latest day and every so
   * often back from it, or midnight and every so many hours on from it, in a
   * step that divides the day.
   */
  const dated = $derived.by(() => {
    const room = Math.max(1, Math.ceil(72 / band));
    const indices: number[] = [];
    if (chart.grain === "hour") {
      const every = [1, 2, 3, 4, 6, 12].find((step) => step >= room) ?? 12;
      for (let index = 0; index < chart.columns.length; index += every) indices.push(index);
      return indices;
    }
    for (let index = chart.columns.length - 1; index >= 0; index -= room) indices.push(index);
    return indices;
  });

  const reading = $derived(active === null ? undefined : chart.columns[active]);

  const cardLeft = $derived.by(() => {
    const center = GUTTER + ((active ?? 0) + 0.5) * band;
    return center + 12 + CARD <= width ? center + 12 : Math.max(0, center - 12 - CARD);
  });

  function heading(column: Column) {
    if (chart.grain === "hour") return formatHours(column.start, column.start);
    return chart.grain === "week"
      ? `Week of ${formatDay(column.start)}`
      : formatDay(column.start, true);
  }

  function describe(column: Column | undefined) {
    if (!column) return "";
    const values = present(column).map(
      (agent) => `${agentDisplay(agent).name} ${formatMeasure(column.values.get(agent), measure)}`,
    );
    return `${heading(column)}: ${values.length > 0 ? values.join(", ") : "no usage"}`;
  }

  /** Open the sessions that used tokens in a column's hour, day or week, when any did. */
  function open(column: Column | undefined) {
    if (!column || column.values.size === 0) return;
    if (chart.grain === "hour") {
      void goto(`${resolve("/sessions")}?hour=${column.start}`);
      return;
    }
    const last = chart.grain === "week" ? addDays(column.start, 6) : column.start;
    void goto(`${resolve("/sessions")}?from=${dayKey(column.start)}&to=${dayKey(last)}`);
  }

  function point(event: PointerEvent & { currentTarget: SVGSVGElement }) {
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left - GUTTER;
    active = Math.max(0, Math.min(chart.columns.length - 1, Math.floor(x / band)));
  }

  function step(event: KeyboardEvent) {
    const last = chart.columns.length - 1;
    if (event.key === "Enter") {
      open(chart.columns[active ?? last]);
      return;
    }
    // With nothing read out yet, the first step back lands on the latest column.
    const from = active ?? last + 1;
    const moves: Partial<Record<string, number>> = {
      ArrowLeft: from - 1,
      ArrowRight: from + 1,
      Home: 0,
      End: last,
    };
    const to = moves[event.key];
    if (to === undefined) return;
    event.preventDefault();
    active = Math.max(0, Math.min(last, to));
  }
</script>

<div class="relative" bind:clientWidth={width}>
  {#if width > 0}
    <svg
      class="block select-none {reading?.values.size ? 'cursor-pointer' : ''}"
      {width}
      height={HEIGHT}
      role="slider"
      tabindex="0"
      aria-label="{measure === 'cost' ? 'Cost' : 'Tokens'} by {chart.grain}"
      aria-valuemin={0}
      aria-valuemax={chart.columns.length - 1}
      aria-valuenow={active ?? chart.columns.length - 1}
      aria-valuetext={describe(chart.columns[active ?? chart.columns.length - 1])}
      onpointermove={point}
      onpointerleave={() => (active = null)}
      onblur={() => (active = null)}
      onclick={() => open(reading)}
      onkeydown={step}
    >
      {#each axis as tick (tick)}
        <line
          class="stroke-border"
          x1={GUTTER}
          x2={width}
          y1={y(tick)}
          y2={y(tick)}
          shape-rendering="crispEdges"
        />
        {#if used}
          <text
            class="fill-muted text-[11px] tabular-nums"
            x={GUTTER - 8}
            y={y(tick)}
            dy="0.32em"
            text-anchor="end">{tickLabel(tick, measure === "cost")}</text
          >
        {/if}
      {/each}

      {#each stacks as stack, index (index)}
        <g class="transition-opacity" style:opacity={active === null || active === index ? 1 : 0.4}>
          {#each stack as part (part.agent)}
            <path d={part.path} style:fill={agentDisplay(part.agent).color} />
          {/each}
        </g>
      {/each}

      {#each dated as index (index)}
        {@const column = chart.columns[index]}
        {#if column}
          <text
            class="fill-muted text-[11px]"
            x={Math.min(width - 22, Math.max(GUTTER + 22, GUTTER + (index + 0.5) * band))}
            y={HEIGHT - 6}
            text-anchor="middle"
            >{chart.grain === "hour" ? formatHour(column.start) : formatDay(column.start)}</text
          >
        {/if}
      {/each}
    </svg>
  {/if}

  {#if !used && width > 0}
    <!-- Backed by the page, so the gridline behind it does not run through it. -->
    <p
      class="pointer-events-none absolute grid place-items-center text-muted"
      style:inset="{TOP}px 0 {FOOT}px {GUTTER}px"
    >
      <span class="bg-content px-3">{empty}</span>
    </p>
  {/if}

  {#if reading}
    <div
      class="pointer-events-none absolute top-0 z-10 grid gap-1 rounded-menu border border-border bg-menu px-3 py-2 text-meta shadow-lg"
      style:left="{cardLeft}px"
      style:width="{CARD}px"
      aria-hidden="true"
    >
      <p class="text-muted">{heading(reading)}</p>
      {#each present(reading) as agent (agent)}
        <p class="flex items-center gap-2">
          <span class="size-2 shrink-0 rounded-full" style:background={agentDisplay(agent).color}
          ></span>
          <span class="min-w-0 flex-1 truncate">{agentDisplay(agent).name}</span>
          <span class="tabular-nums">{formatMeasure(reading.values.get(agent), measure)}</span>
        </p>
      {:else}
        <p>No usage</p>
      {/each}
      {#if reading.values.size > 1}
        <p class="flex justify-between font-medium">
          <span>Total</span>
          <span class="tabular-nums">{formatMeasure(reading.total, measure)}</span>
        </p>
      {/if}
    </div>
  {/if}
</div>

<ul class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-meta" aria-label="Agents">
  {#each chart.agents as [agent, total] (agent)}
    <li class="flex items-center gap-1.5">
      <span class="size-2 rounded-full" style:background={agentDisplay(agent).color}></span>
      <span class="text-muted">{agentDisplay(agent).name}</span>
      <span class="tabular-nums">{formatMeasure(total, measure)}</span>
    </li>
  {/each}
</ul>
