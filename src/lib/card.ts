/**
 * The card a reader shares: what a period says about their agents, and how that
 * is drawn into a picture.
 *
 * A card is an artifact rather than a view. It leaves the app and is looked at
 * somewhere else, so it is drawn at a fixed size into a canvas and carries its
 * own copy of the theme's colours: the same period drawn twice is the same
 * picture, whatever the window is doing meanwhile. The colours mirror
 * `app.css`, which is where the window reads them from; a change there belongs
 * here too.
 *
 * What the card says is built apart from how it is drawn, so the claims can be
 * checked without a canvas.
 */
import type { Agent, ModelUsage, Overview } from "./api/backend.ts";
import { agentDisplay } from "./agents.ts";
import { MARKS, type MarkName } from "./components/marks/marks.ts";
import {
  formatCount,
  formatCountCompact,
  formatDays,
  formatMeasure,
  formatPercent,
  formatUsd,
  type Measure,
} from "./format.ts";
import { dayKey, periodStart, startOfDay } from "./periods.ts";

/** Which of the app's two palettes a card is drawn in. */
export type Theme = "light" | "dark";

/**
 * The card's size in points, drawn at {@link SCALE} times this.
 *
 * Just under two to one, which is what the places a card is posted to show
 * whole rather than crop.
 */
export const WIDTH = 1200;
export const HEIGHT = 630;

/** How many device pixels a point becomes, so the picture survives a retina timeline. */
const SCALE = 2;

/** One model's line on the card. */
export interface CardModel {
  model: string;
  /** The agent whose mark stands beside it, and whose colour its bar takes. */
  agent: Agent;
  /** How much it used, already written out. */
  value: string;
  /** Its share of the largest model's, from 0 to 1, which is the bar's length. */
  share: number;
}

/** One agent's line on the card. */
export interface CardAgent {
  agent: Agent;
  /** How much it used, which is its width in the band along the top. */
  value: number;
  /** Its share of the busiest agent's, from 0 to 1, which is the bar's length. */
  share: number;
  /** The same amount, already written out. */
  label: string;
}

/** Everything the card says. */
export interface Card {
  /** The file it saves under, without an extension. */
  name: string;
  /** What the period is called, such as `Last 7 days`. */
  period: string;
  /** The days it covers, such as `Sep 10 – 16`; empty when nothing is recorded. */
  range: string;
  measure: Measure;
  /** The figures across the top, the first of which is the card's headline. */
  figures: { label: string; value: string }[];
  /** One sentence about the period, or empty when there is nothing to say. */
  line: string;
  /** The models that used the most, largest first. */
  models: CardModel[];
  /** The agents that used the most, largest first. */
  agents: CardAgent[];
}

/** How many models and agents a card ranks. */
const SHOWN = 5;

/** What a period is called on the card. */
function periodName(days: number | null): string {
  return days === null ? "All time" : `Last ${days} days`;
}

/** The part of a file name a period contributes. */
function periodSlug(days: number | null): string {
  return days === null ? "all-time" : `${days}-days`;
}

/** One model's usage by the measure shown; null when it has no price to show. */
function usage(model: ModelUsage, measure: Measure): number | null {
  return measure === "cost" ? model.costUsd : model.tokens.total;
}

/**
 * The sentence under the figures.
 *
 * It says the one thing a reader would say out loud about a week of work: which
 * model did it. A share needs a denominator, so a period whose usage has no
 * price says nothing rather than something made up.
 */
function verdict(models: readonly CardModel[], total: number, top: number, measure: Measure) {
  if (models.length === 0) return "";
  const first = models[0];
  if (first === undefined) return "";
  if (models.length === 1) return `${first.model}, and nothing else.`;
  if (total <= 0) return `${models.length} models in play.`;
  const share = formatPercent((top / total) * 100);
  return measure === "cost"
    ? `${first.model} took ${share} of the spend.`
    : `${first.model} did ${share} of the work.`;
}

/**
 * What the card says about a period.
 *
 * The clock is a parameter so that the file name and the range a card claims
 * are the ones its reader's day would give it.
 */
export function card(input: {
  overview: Overview;
  models: readonly ModelUsage[];
  days: number | null;
  measure: Measure;
  now?: Date;
}): Card {
  const { overview, models, days, measure } = input;
  const now = input.now ?? new Date();
  const since = periodStart(days, now.getTime());
  const first = since ?? overview.daily[0]?.day;

  const used = overview.byAgent
    .map((share) => {
      const value = measure === "cost" ? share.costUsd : share.tokens.total;
      // A bar needs a number, and unpriced usage has no width by cost, so an
      // agent with nothing to measure is left out rather than drawn as empty.
      return { agent: share.agent, value: value ?? 0, label: formatMeasure(value, measure) };
    })
    .filter((share) => share.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, SHOWN);
  const busiest = Math.max(0, ...used.map((share) => share.value));
  const agents: CardAgent[] = used.map((share) => ({
    ...share,
    share: busiest > 0 ? share.value / busiest : 0,
  }));

  const ranked = [...models]
    .sort((a, b) => (usage(b, measure) ?? -1) - (usage(a, measure) ?? -1))
    .slice(0, SHOWN);
  const largest = Math.max(0, ...ranked.map((model) => usage(model, measure) ?? 0));
  const priced = models.reduce((sum, model) => sum + (usage(model, measure) ?? 0), 0);
  const shown: CardModel[] = ranked.map((model) => ({
    model: model.model,
    agent: model.agents[0] ?? "claude_code",
    value: formatMeasure(usage(model, measure), measure),
    share: largest > 0 ? (usage(model, measure) ?? 0) / largest : 0,
  }));

  const tokens = { label: "Tokens", value: formatCountCompact(overview.tokens.total) };
  const cost = { label: "Estimated cost", value: formatUsd(overview.costUsd) };
  const figures =
    measure === "cost"
      ? [cost, tokens, { label: "Sessions", value: formatCount(overview.sessions) }]
      : [tokens, cost, { label: "Sessions", value: formatCount(overview.sessions) }];
  figures.push({ label: "Models", value: formatCount(models.length) });

  return {
    name: `overwatch-${periodSlug(days)}-${dayKey(now.getTime())}`,
    period: periodName(days),
    range: first === undefined ? "" : formatDays(first, startOfDay(now.getTime()), now),
    measure,
    figures,
    line: verdict(shown, priced, largest, measure),
    models: shown,
    agents,
  };
}

/** The two palettes a card is drawn in, mirroring the theme tokens in `app.css`. */
interface Palette {
  background: string;
  text: string;
  muted: string;
  border: string;
  /** Behind a bar that is not full. */
  track: string;
  agent: Record<Agent, string>;
}

const PALETTES: Record<Theme, Palette> = {
  light: {
    background: "#fafafa",
    text: "#262626",
    muted: "#666666",
    border: "#e4e4e4",
    track: "#e9e9e9",
    agent: {
      claude_code: "#d97757",
      codex: "#10a37f",
      open_code: "#4f86e8",
      pi: "#9a76dc",
      grok_build: "#7c8797",
    },
  },
  dark: {
    background: "#171717",
    text: "#ededed",
    muted: "#a1a1a1",
    border: "#262626",
    track: "#222222",
    agent: {
      claude_code: "#e58a6b",
      codex: "#34bf94",
      open_code: "#74a1f0",
      pi: "#b596ea",
      grok_build: "#9aa4b2",
    },
  },
};

const SANS = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONO = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

/** Where the app's own repository is named, for anyone who asks what this is. */
const SOURCE = "github.com/joeychilson/overwatch";

/**
 * Where the card's bands sit, in points from the top and the left.
 *
 * A picture has no reflow to fall back on, so every band is placed rather than
 * flowed, and only the widths within a band are measured.
 */
const PAD = 56;
const LEFT = PAD;
const RIGHT = WIDTH - PAD;
/** The full-bleed band of agent colour along the very top. */
const MIX = 5;
/** The centre line of the brand row, which the mark and the period share. */
const TOP = 58;
/** Baselines of the figures' labels and of the figures themselves. */
const LABELS = 136;
const FIGURES = 198;
/** Baseline of the sentence, which the rankings stand well clear of. */
const LINE = 240;
/** Baseline of the rankings' headings, the top of their first row, and a row. */
const HEADING = 302;
const ROWS = 316;
const ROW = 46;
/** Baseline of the footer. */
const FOOT = 582;

/**
 * The two rankings, side by side.
 *
 * Models take the width their identifiers need and agents take the rest, since
 * an agent's name is a word or two and never grows.
 */
const MODELS_WIDTH = 656;
const AGENTS_LEFT = LEFT + MODELS_WIDTH + 56;
const MODELS_BAR = 224;
const AGENTS_BAR = 104;
/**
 * The amount at the end of a row, right-aligned against the column's rail.
 *
 * Wide enough for a four-figure sum to the cent, since by cost a single model
 * can carry most of a long period's spend.
 */
const VALUE = 96;

/** How a run of text is set. */
interface Type {
  size: number;
  color: string;
  weight?: number;
  /** Tracking in points, as the theme's type scale gives it. */
  spacing?: number;
  align?: CanvasTextAlign;
  /** Model identifiers are set in the same monospace the app sets them in. */
  mono?: boolean;
}

/** Take a type on, and answer how wide the text is in it. */
function measured(ctx: CanvasRenderingContext2D, value: string, type: Type): number {
  ctx.font = `${type.weight ?? 400} ${type.size}px ${type.mono === true ? MONO : SANS}`;
  ctx.letterSpacing = `${type.spacing ?? 0}px`;
  return ctx.measureText(value).width;
}

/** Draw one run of text, and answer how wide it was. */
function write(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  type: Type,
): number {
  const width = measured(ctx, value, type);
  ctx.fillStyle = type.color;
  ctx.textAlign = type.align ?? "left";
  ctx.fillText(value, x, y);
  return width;
}

/** `value` cut to `limit` points, with an ellipsis standing where it was cut. */
function fit(ctx: CanvasRenderingContext2D, value: string, type: Type, limit: number): string {
  if (measured(ctx, value, type) <= limit) return value;
  let cut = value;
  while (cut.length > 1 && measured(ctx, `${cut}…`, type) > limit) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** A filled rectangle with rounded corners, given as one radius or four. */
function box(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number | number[],
) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

/** The app's own mark: a ring with a pupil, as the sidebar draws it. */
function drawRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
) {
  const unit = size / 24;
  const middle = size / 2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2 * unit;
  ctx.beginPath();
  ctx.arc(x + middle, y + middle, 9 * unit, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + middle, y + middle, 3 * unit, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * One brand mark, from the same geometry the window draws.
 *
 * A mark carries no fill of its own, so the colour is given here, and one that
 * asks to be inset keeps its proportions about the centre of the same box.
 */
function drawMark(
  ctx: CanvasRenderingContext2D,
  name: MarkName,
  x: number,
  y: number,
  size: number,
  color: string,
) {
  const mark = MARKS[name];
  const [minX = 0, minY = 0, boxWidth = size, boxHeight = size] = mark.viewBox
    .split(/\s+/)
    .map(Number);
  const inset = mark.scale ?? 1;
  ctx.save();
  ctx.fillStyle = color;
  ctx.translate(x + size / 2, y + size / 2);
  ctx.scale((inset * size) / boxWidth, (inset * size) / boxHeight);
  ctx.translate(-(minX + boxWidth / 2), -(minY + boxHeight / 2));
  for (const path of mark.paths) {
    ctx.fill(new Path2D(path.d), path.evenOdd === true ? "evenodd" : "nonzero");
  }
  ctx.restore();
}

/** The agents' shares of the whole period, as one band across the top edge. */
function drawMix(ctx: CanvasRenderingContext2D, card: Card, palette: Palette) {
  const total = card.agents.reduce((sum, share) => sum + share.value, 0);
  if (total <= 0) {
    ctx.fillStyle = palette.border;
    ctx.fillRect(0, 0, WIDTH, MIX);
    return;
  }
  let x = 0;
  for (const share of card.agents) {
    ctx.fillStyle = palette.agent[share.agent];
    // Each band runs to the right edge and the next paints over its tail, so
    // rounding leaves no seam and the smallest share still reaches the corner.
    ctx.fillRect(Math.floor(x), 0, Math.ceil(WIDTH - x), MIX);
    x += (share.value / total) * WIDTH;
  }
}

/**
 * The period, in a pill at the far end of the brand row.
 *
 * Which days a card is of is the first thing anyone reading it over someone's
 * shoulder asks, so it is a label in the reader's own colour rather than a line
 * of small grey text.
 */
function drawPeriod(ctx: CanvasRenderingContext2D, card: Card, palette: Palette) {
  const name: Type = { size: 14, weight: 600, spacing: -0.1, color: palette.text };
  const range: Type = { size: 14, spacing: -0.1, color: palette.muted };
  const gap = card.range === "" ? 0 : 9;
  const inside = measured(ctx, card.period, name) + gap + measured(ctx, card.range, range);
  const height = 32;
  const left = Math.round(RIGHT - inside - 28);

  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(left, TOP - height / 2, inside + 28, height, 7);
  ctx.stroke();

  const written = write(ctx, card.period, left + 14, TOP + 5, name);
  if (card.range !== "") write(ctx, card.range, left + 14 + written + gap, TOP + 5, range);
}

/** The app's name, and which days the card is of. */
function drawBrand(ctx: CanvasRenderingContext2D, card: Card, palette: Palette) {
  drawRing(ctx, LEFT, TOP - 11, 22, palette.text);
  write(ctx, "Overwatch", LEFT + 32, TOP + 6, {
    size: 16,
    weight: 600,
    spacing: -0.6,
    color: palette.text,
  });
  drawPeriod(ctx, card, palette);
}

/** The period's figures, the first of them the card's headline. */
function drawFigures(ctx: CanvasRenderingContext2D, card: Card, palette: Palette) {
  const label: Type = { size: 11, weight: 600, spacing: 0.9, color: palette.muted };
  const headline: Type = { size: 66, weight: 600, spacing: -1.9, color: palette.text };
  const rest: Type = { size: 22, weight: 500, spacing: -0.4, color: palette.text };
  let x = LEFT;
  card.figures.forEach((figure, index) => {
    const type = index === 0 ? headline : rest;
    const heading = figure.label.toUpperCase();
    const width = Math.max(measured(ctx, heading, label), measured(ctx, figure.value, type));
    write(ctx, heading, x, LABELS, label);
    write(ctx, figure.value, x, FIGURES, type);
    x += width + (index === 0 ? 56 : 44);
  });

  if (card.line !== "") {
    const type: Type = { size: 16, spacing: -0.2, color: palette.text };
    write(ctx, fit(ctx, card.line, type, RIGHT - LEFT), LEFT, LINE, type);
  }
}

/** One line of a ranking: what it is, a bar against the largest, and how much. */
interface Line {
  mark: MarkName;
  /** What its mark is drawn in. */
  marked: string;
  /** What its bar is drawn in. */
  color: string;
  label: string;
  /** Whether the label is an identifier, which is set in monospace. */
  mono: boolean;
  value: string;
  /** Its share of the largest in the same ranking, from 0 to 1. */
  share: number;
}

/** One column of ranked lines, under a heading. */
interface Ranking {
  heading: string;
  /** The column's left rail, and how wide it is. */
  left: number;
  width: number;
  /** How long a full bar is in this column. */
  bar: number;
  /** What to say when there is nothing to rank. */
  empty: string;
  lines: Line[];
}

function drawRanking(ctx: CanvasRenderingContext2D, palette: Palette, ranking: Ranking) {
  const right = ranking.left + ranking.width;
  write(ctx, ranking.heading, ranking.left, HEADING, {
    size: 11,
    weight: 600,
    spacing: 0.9,
    color: palette.muted,
  });

  if (ranking.lines.length === 0) {
    write(ctx, ranking.empty, ranking.left, ROWS + 28, { size: 15, color: palette.muted });
    return;
  }

  const amount: Type = { size: 14, weight: 500, color: palette.text, align: "right" };
  const track = right - VALUE - 14 - ranking.bar;
  ranking.lines.forEach((line, index) => {
    const middle = ROWS + index * ROW + ROW / 2;
    const name: Type = { size: 14, spacing: -0.1, color: palette.text, mono: line.mono };
    drawMark(ctx, line.mark, ranking.left, middle - 8, 16, line.marked);
    write(
      ctx,
      fit(ctx, line.label, name, track - 20 - ranking.left - 28),
      ranking.left + 28,
      middle + 5,
      name,
    );
    ctx.fillStyle = palette.track;
    box(ctx, track, middle - 3, ranking.bar, 6, 3);
    // Something that barely registers still gets a mark of a bar, so a row
    // never reads as nothing at all. An amount the engine could not establish
    // gets no bar, because unknown is not a small number.
    if (line.share > 0) {
      ctx.fillStyle = line.color;
      box(ctx, track, middle - 3, Math.max(6, ranking.bar * line.share), 6, 3);
    }
    write(ctx, line.value, right, middle + 5, amount);
  });
}

/**
 * What used the most, by model and by agent, in two columns.
 *
 * A model's mark says whose it is and stands in the muted grey the window uses;
 * an agent's takes its own colour, which is what the band along the top and
 * every bar on the card are keyed to.
 */
function drawRankings(ctx: CanvasRenderingContext2D, card: Card, palette: Palette) {
  drawRanking(ctx, palette, {
    heading: "TOP MODELS",
    left: LEFT,
    width: MODELS_WIDTH,
    bar: MODELS_BAR,
    empty: "No models used tokens.",
    lines: card.models.map((model) => ({
      mark: agentDisplay(model.agent).mark,
      marked: palette.muted,
      color: palette.agent[model.agent],
      label: model.model,
      mono: true,
      value: model.value,
      share: model.share,
    })),
  });

  drawRanking(ctx, palette, {
    heading: "AGENTS",
    left: AGENTS_LEFT,
    width: RIGHT - AGENTS_LEFT,
    bar: AGENTS_BAR,
    empty: "No agents ran.",
    lines: card.agents.map((share) => ({
      mark: agentDisplay(share.agent).mark,
      marked: palette.agent[share.agent],
      color: palette.agent[share.agent],
      label: agentDisplay(share.agent).name,
      mono: false,
      value: share.label,
      share: share.share,
    })),
  });
}

/** Where the app is, and what its money figures are and are not. */
function drawFoot(ctx: CanvasRenderingContext2D, card: Card, palette: Palette) {
  const type: Type = { size: 12, color: palette.muted };
  write(ctx, SOURCE, LEFT, FOOT, type);
  if (card.measure === "cost") {
    write(ctx, "Estimated at list prices", RIGHT, FOOT, { ...type, align: "right" });
  }
}

/**
 * Draw a card into a canvas, sizing the canvas to hold it.
 *
 * The canvas is drawn in points and backed by {@link SCALE} times as many
 * pixels, so the picture holds up where it is shown at full size. Drawing is
 * the only thing that touches the canvas: the caller decides when, and saves
 * what came out.
 */
export function draw(canvas: HTMLCanvasElement, card: Card, theme: Theme): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const palette = PALETTES[theme];
  canvas.width = WIDTH * SCALE;
  canvas.height = HEIGHT * SCALE;
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  drawMix(ctx, card, palette);
  drawBrand(ctx, card, palette);
  drawFigures(ctx, card, palette);
  drawRankings(ctx, card, palette);
  drawFoot(ctx, card, palette);
}
