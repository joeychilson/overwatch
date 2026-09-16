/**
 * Record one walk through the whole app, from sample data.
 *
 * The same served build, history and frame the screenshots use, driven instead
 * of held still: the walk switches what the overview measures and over how
 * long, reads down it, finds a session in the list and opens it, moves along
 * its timeline and picks a turn off it, opens a run of tool calls and then one
 * of the calls, and carries on through the models and the subscriptions before
 * coming back to where it started, so the recording loops. It shows how the
 * window behaves rather than how it looked at one moment.
 *
 * A browser draws no pointer, and a recording without one reads as things
 * moving by themselves, so one is drawn on the page and follows the mouse the
 * walk moves.
 *
 * Run with `vp run record`. To hand the result to a README as a GIF:
 * `ffmpeg -i .github/assets/overwatch-tour.webm -vf fps=15,scale=900:-1:flags=lanczos overwatch-tour.gif`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { FRAME, HEIGHT, OUT, WIDTH, capture } from "./capture.ts";

/** How long a reader is given to take in what just changed. */
const BEAT = 900;

/** Move to a control the way a hand would, press it, and let the result land. */
async function tap(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error(`Nothing to press at ${String(target)}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
  await page.waitForTimeout(BEAT / 3);
  // The press itself goes through the control rather than the point it was at:
  // opening one thing moves what is under it, and a walk that pressed the old
  // point would open something else.
  await target.click({ delay: 90 });
  await page.waitForTimeout(BEAT);
}

/** Scroll the way a hand would, a little at a time rather than in one jump. */
async function roll(page: Page, distance: number, steps = 14): Promise<void> {
  await page.mouse.move(WIDTH / 2, HEIGHT / 2);
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel(0, distance / steps);
    await page.waitForTimeout(55);
  }
  await page.waitForTimeout(BEAT);
}

/**
 * The first of these with room to spare on screen.
 *
 * What the walk opens has to be something a reader can already see, and where
 * a run of tool calls falls depends on the turn the timeline just brought into
 * view.
 */
async function onScreen(targets: Locator): Promise<Locator> {
  const count = await targets.count();
  for (let index = 0; index < count; index += 1) {
    const box = await targets.nth(index).boundingBox();
    if (box && box.y > 120 && box.y + box.height < HEIGHT - 160) return targets.nth(index);
  }
  throw new Error("Nothing of that kind is on screen");
}

/**
 * Draw a pointer that follows the mouse.
 *
 * It lives on the document rather than inside the app, so it survives the
 * walk's own navigation between pages.
 */
async function pointer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dot = document.createElement("div");
    dot.style.cssText = [
      "position:fixed;left:-100px;top:-100px;z-index:999",
      "width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%",
      "background:rgb(255 255 255 / 0.5)",
      "box-shadow:0 0 0 1.5px rgb(0 0 0 / 0.4), 0 2px 8px rgb(0 0 0 / 0.4)",
      "pointer-events:none;transition:transform 120ms ease",
    ].join(";");
    document.body.append(dot);
    addEventListener(
      "mousemove",
      (event) => {
        dot.style.left = `${event.clientX}px`;
        dot.style.top = `${event.clientY}px`;
      },
      { passive: true },
    );
    addEventListener("mousedown", () => (dot.style.transform = "scale(0.62)"), { passive: true });
    addEventListener("mouseup", () => (dot.style.transform = "scale(1)"), { passive: true });
  });
}

const videos = await mkdtemp(join(tmpdir(), "overwatch-record-"));
try {
  await capture(async (open) => {
    // A recording is played at its own size, so one device pixel to a CSS
    // pixel is enough and keeps the file small.
    const page = await open("/", {
      scale: 1,
      video: { dir: videos, size: { width: WIDTH, height: HEIGHT } },
    });
    // Sought inside the navigation, and by part of the name rather than all of
    // it: Subscriptions carries the mark for a limit running out.
    const sidebar = (name: string) =>
      page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name });

    await page.getByRole("list", { name: "Top sessions" }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: FRAME });
    await pointer(page);
    await page.waitForTimeout(BEAT);

    // What the overview measures, and over how long.
    await tap(page, page.getByRole("button", { name: "Cost", exact: true }));
    await tap(page, page.getByRole("button", { name: "90 days" }));
    await roll(page, 700);
    await page.waitForTimeout(BEAT);

    // Down the list, then straight to one session by name.
    await tap(page, sidebar("Sessions"));
    const rows = page.getByRole("list", { name: "Sessions" }).getByRole("listitem");
    await rows.first().waitFor();
    await roll(page, 500);
    await roll(page, -500);
    await tap(page, page.getByRole("searchbox", { name: "Search sessions" }));
    await page.keyboard.type("idempotency", { delay: 70 });
    await page.waitForTimeout(BEAT);
    await tap(page, rows.first().getByRole("link").first());

    // Along the timeline, which moves the conversation with it, and then onto
    // one turn of it, which is what a reader has to see to know they can.
    const timeline = page.getByRole("slider", { name: "Timeline" });
    await timeline.waitFor();
    await page.getByRole("article").first().waitFor();
    await page.waitForTimeout(BEAT);
    const track = await timeline.boundingBox();
    if (!track) throw new Error("No timeline to walk along");
    const along = (fraction: number) => track.x + track.width * fraction;
    const middle = track.y + track.height / 2;
    await page.mouse.move(along(0.08), middle, { steps: 16 });
    await page.mouse.down();
    for (let at = 0.08; at <= 0.62; at += 0.045) {
      await page.mouse.move(along(at), middle, { steps: 4 });
      await page.waitForTimeout(70);
    }
    await page.mouse.up();
    await page.waitForTimeout(BEAT);
    await page.mouse.move(along(0.33), middle, { steps: 20 });
    await page.waitForTimeout(BEAT / 2);
    await page.mouse.down();
    await page.waitForTimeout(90);
    await page.mouse.up();
    await page.waitForTimeout(BEAT * 1.4);

    // Into a run of tool calls, and then into one of the calls, which carries
    // what it was given and what it answered. The lines that open are named by
    // the attribute rather than by the state it holds: opening one changes
    // that state, and a locator reading it would move on to the next run.
    const openable = page.locator("main button[aria-expanded]");
    const gathered = await onScreen(openable.filter({ hasText: "·" }));
    await tap(page, gathered);
    const calls = gathered.locator("..").locator("div button[aria-expanded]");
    // A command reads best: both what it ran and what came back are worth
    // seeing. Failing that, anything but recorded thinking.
    const commands = calls.filter({ hasText: "Bash" });
    const call = (await commands.count()) > 0 ? commands : calls.filter({ hasNotText: "Thinking" });
    await tap(page, call.first());
    await roll(page, 360, 10);

    // What each model costs across every agent, and one model's own sessions.
    await tap(page, sidebar("Models"));
    await page.getByRole("list", { name: "Models" }).waitFor();
    await page.waitForTimeout(BEAT);
    await tap(page, page.getByRole("list", { name: "Models" }).getByRole("link").first());
    await rows.first().waitFor();
    await page.waitForTimeout(BEAT);

    // How much of each subscription is left, and back to where this began.
    await tap(page, sidebar("Subscriptions"));
    await page.getByRole("heading", { name: "Codex" }).waitFor();
    await page.waitForTimeout(BEAT);
    await roll(page, 320, 8);
    await roll(page, -320, 8);
    await tap(page, sidebar("Overview"));
    await page.getByRole("list", { name: "Top sessions" }).waitFor();
    await page.waitForTimeout(BEAT * 1.5);

    const video = page.video();
    // The recording is only complete once its page is closed.
    await page.close();
    const out = `${OUT}/overwatch-tour.webm`;
    await video?.saveAs(out);
    console.log(`Wrote ${out} (${WIDTH}×${HEIGHT})`);
  });
} finally {
  await rm(videos, { recursive: true, force: true });
}
