/**
 * Render screenshots of every page from sample data.
 *
 * Serves the built frontend, answers every engine command from a made-up but
 * plausible history, and captures each page as the app's window shows it, so
 * the pictures show the real interface and nobody's history. The history is
 * drawn the same way each run and the clock is fixed, so a picture changes
 * only when the interface does.
 *
 * A browser draws no window, so the frame of one — its rounded corners, the
 * highlight along its top and the traffic lights — is drawn over the page to
 * match a capture of the app's own window. The menu bar panel is drawn on a
 * stand-in for its material.
 *
 * Run with `vp run screenshot` to render every shot, or name some, as in
 * `vp run screenshot session models`, and commit the ones the README shows.
 */
import { chromium, type Page } from "@playwright/test";
import { preview } from "vite-plus";
import { FEATURED, NOW, answer } from "./sample/history.ts";

const OUT = ".github/assets";
/** The window's default size, from `tauri.conf.json`. */
const WIDTH = 1200;
const HEIGHT = 800;

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

/** The window's frame, measured from a capture of the app's own window. */
const FRAME = `
  :root { background: transparent; }
  div:has(> main) { position: relative; border-radius: 16px; }
  div:has(> main)::after {
    content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
    box-shadow: inset 0 1px rgb(255 255 255 / 0.14);
  }
  div:has(> main)::before {
    content: ""; position: absolute; top: 9px; left: 12px; width: 60px; height: 14px; z-index: 60;
    background:
      radial-gradient(circle at 7px 7px, #ff5c5f 6.5px, transparent 7px),
      radial-gradient(circle at 30px 7px, #fac800 6.5px, transparent 7px),
      radial-gradient(circle at 53px 7px, #34c759 6.5px, transparent 7px);
  }
`;

/** A dark popover's material, which the panel's page is transparent over. */
const MATERIAL = `
  .w-85 {
    background: #2b2b2d; border-radius: 10px;
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.1);
  }
`;

const wanted = process.argv.slice(2);
const unknown = wanted.filter((name) => !SHOTS.some((shot) => shot.name === name));
if (unknown.length > 0) {
  throw new Error(
    `No shot named ${unknown.join(", ")}; shots are ${SHOTS.map((shot) => shot.name).join(", ")}`,
  );
}
const shots = wanted.length === 0 ? SHOTS : SHOTS.filter((shot) => wanted.includes(shot.name));

const server = await preview();
const browser = await chromium.launch();
try {
  const origin = server.resolvedUrls?.local[0] ?? "http://127.0.0.1:1432/";
  for (const shot of shots) {
    const width = shot.width ?? WIDTH;
    const page = await browser.newPage({
      viewport: { width, height: typeof shot.height === "number" ? shot.height : HEIGHT },
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    await page.clock.setFixedTime(NOW);
    await page.exposeFunction("answer", answer);
    await page.addInitScript(() => {
      const engine = window as unknown as {
        answer: (cmd: string, args: Record<string, unknown>) => unknown;
      };
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => engine.answer(cmd, args ?? {}),
          transformCallback: () => 0,
          unregisterCallback: () => undefined,
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      });
    });

    await page.goto(new URL(shot.path, origin).href);
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
} finally {
  await browser.close();
  await server.close();
}
