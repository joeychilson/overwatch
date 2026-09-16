/**
 * Render screenshots of every page from sample data.
 *
 * Each page is captured as the app's window shows it, on the frame and clock
 * `capture.ts` sets up, so the pictures show the real interface and nobody's
 * history, and one changes only when the interface does.
 *
 * Run with `vp run screenshot` to render every shot, or name some, as in
 * `vp run screenshot session models`, and commit the ones the README shows.
 */
import type { Page } from "@playwright/test";
import { FEATURED } from "./sample/history.ts";
import { FRAME, HEIGHT, MATERIAL, OUT, WIDTH, capture, chosen } from "./capture.ts";

interface Shot {
  name: string;
  path: string;
  /** Resolves once the page shows what it read. */
  ready: (page: Page) => Promise<void>;
  width?: number;
  /** A height in pixels, or as tall as the page so nothing is cut off. */
  height: number | "content";
  /** The menu bar panel is a window of its own, without the app's frame. */
  panel?: boolean;
}

const SHOTS: Shot[] = [
  {
    name: "overview",
    path: "/",
    height: "content",
    ready: (page) => page.getByRole("list", { name: "Top sessions" }).waitFor(),
  },
  {
    name: "sessions",
    path: "/sessions",
    // Wide enough for the list's model column.
    width: 1440,
    height: 900,
    ready: (page) =>
      page.getByRole("list", { name: "Sessions" }).getByRole("listitem").first().waitFor(),
  },
  {
    name: "session",
    path: `/sessions/${FEATURED.id}`,
    // The overview's height, so the README can set the two side by side.
    height: 1023,
    ready: async (page) => {
      await page.getByRole("slider", { name: "Timeline" }).waitFor();
      await page.getByRole("article").first().waitFor();
    },
  },
  {
    name: "models",
    path: "/models",
    height: "content",
    ready: (page) => page.getByRole("list", { name: "Models" }).waitFor(),
  },
  {
    name: "subscriptions",
    path: "/subscriptions",
    height: "content",
    ready: (page) => page.getByRole("heading", { name: "Codex" }).waitFor(),
  },
  {
    name: "menu-bar",
    path: "/tray",
    height: HEIGHT,
    panel: true,
    ready: (page) => page.getByRole("button", { name: "Open Overwatch" }).waitFor(),
  },
];

await capture(async (open) => {
  for (const shot of chosen(SHOTS, "shot")) {
    const width = shot.width ?? WIDTH;
    const page = await open(shot.path, {
      width,
      height: typeof shot.height === "number" ? shot.height : HEIGHT,
    });

    await shot.ready(page);
    await page.evaluate(() => document.fonts.ready);
    const out = `${OUT}/overwatch-${shot.name}.png`;

    if (shot.panel) {
      await page.addStyleTag({ content: MATERIAL });
      await page
        .locator(".w-85")
        .screenshot({ path: out, omitBackground: true, animations: "disabled" });
    } else {
      await page.addStyleTag({ content: FRAME });
      if (shot.height === "content") {
        const main = page.getByRole("main");
        const bottom = await main.evaluate(
          (node) => node.getBoundingClientRect().top + node.scrollHeight,
        );
        await page.setViewportSize({ width, height: Math.max(HEIGHT, Math.ceil(bottom)) });
      }
      await page.screenshot({ path: out, omitBackground: true, animations: "disabled" });
    }
    const size = page.viewportSize();
    console.log(`Wrote ${out}${shot.panel ? "" : ` (${size?.width}×${size?.height} at 2×)`}`);
    await page.close();
  }
});
