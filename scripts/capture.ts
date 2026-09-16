/**
 * A browser standing in for the app's window.
 *
 * The pictures and the walkthroughs are both taken from the built frontend
 * served locally, with every engine command answered from a made-up but
 * plausible history and the clock fixed, so what they show is the real
 * interface and nobody's history. The history is drawn the same way each run,
 * so a picture changes only when the interface does.
 *
 * A browser draws no window, so the frame of one — its rounded corners, the
 * highlight along its top and the traffic lights — is drawn over the page to
 * match a capture of the app's own window. The menu bar panel is drawn on a
 * stand-in for its material.
 */
import { chromium, type Page } from "@playwright/test";
import { preview } from "vite-plus";
import { NOW, answer } from "./sample/history.ts";

/** Where the pictures and walkthroughs are written. */
export const OUT = ".github/assets";
/** The window's default size, from `tauri.conf.json`. */
export const WIDTH = 1200;
export const HEIGHT = 800;

/** The window's frame, measured from a capture of the app's own window. */
export const FRAME = `
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
export const MATERIAL = `
  .w-85 {
    background: #2b2b2d; border-radius: 10px;
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.1);
  }
`;

export interface PageOptions {
  width?: number;
  height?: number;
  /** Device pixels to a CSS pixel: two for a picture, one for a recording. */
  scale?: number;
  /** Where to write a recording of the page, and how large to record it. */
  video?: { dir: string; size: { width: number; height: number } };
}

/** Open a page at `path`, showing the history. */
export type Open = (path: string, options?: PageOptions) => Promise<Page>;

/** Serve the built frontend, hand `take` a way to open pages on it, and put everything away after. */
export async function capture(take: (open: Open) => Promise<void>): Promise<void> {
  const server = await preview();
  const browser = await chromium.launch();
  try {
    const origin = server.resolvedUrls?.local[0] ?? "http://127.0.0.1:1432/";
    await take(async (path, options = {}) => {
      const page = await browser.newPage({
        viewport: { width: options.width ?? WIDTH, height: options.height ?? HEIGHT },
        deviceScaleFactor: options.scale ?? 2,
        colorScheme: "dark",
        recordVideo: options.video,
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
      await page.goto(new URL(path, origin).href);
      return page;
    });
  } finally {
    await browser.close();
    await server.close();
  }
}

/** The ones named on the command line, or all of them, refusing a name that is not there. */
export function chosen<T extends { name: string }>(all: T[], kind: string): T[] {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((name) => !all.some((each) => each.name === name));
  if (unknown.length > 0) {
    throw new Error(
      `No ${kind} named ${unknown.join(", ")}; ${kind}s are ${all.map((each) => each.name).join(", ")}`,
    );
  }
  return wanted.length === 0 ? all : all.filter((each) => wanted.includes(each.name));
}
