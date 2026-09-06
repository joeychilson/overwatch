import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktop } from "./desktop";

test("primary workflows remain usable at 200 percent browser zoom", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "Chrome's extension zoom API is specific to Chromium.");
  const directory = await mkdtemp(join(tmpdir(), "overwatch-zoom-"));
  let context;
  try {
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Local zoom test",
        version: "1.0",
        permissions: ["tabs"],
        background: { service_worker: "worker.js" },
      }),
    );
    await writeFile(
      join(directory, "worker.js"),
      "chrome.runtime.onInstalled.addListener(() => {});",
    );
    context = await chromium.launchPersistentContext(join(directory, "profile"), {
      channel: "chromium",
      headless: true,
      viewport: { width: 1440, height: 1000 },
      args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const page = await context.newPage();
    await desktop(page, { longNames: true });
    await page.goto(process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:1420");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    const before = await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio }));
    const zoom = await worker.evaluate(async () => {
      // Chrome's native browser zoom, not CSS zoom or pinch emulation.
      const api = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              query: (query: object) => Promise<{ id: number; url: string }[]>;
              setZoom: (id: number, zoom: number) => Promise<void>;
              getZoom: (id: number) => Promise<number>;
            };
          };
        }
      ).chrome.tabs;
      const tabs = await api.query({});
      const tab = tabs.find((tab) => tab.url.startsWith("http://127.0.0.1:"))!;
      await api.setZoom(tab.id, 2);
      return api.getZoom(tab.id);
    });
    expect(zoom).toBe(2);
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(before.ratio * 2);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(before.width / 2);
    for (const view of ["Overview", "Sessions", "Models", "Subscriptions", "Connections"]) {
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: view, exact: true })
        .click();
      await expect(page.getByRole("heading", { name: view, exact: true })).toBeVisible();
      await expect
        .poll(() =>
          page
            .locator('[data-slot="page-scroll"]')
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        )
        .toBe(true);
      await page.screenshot({ path: `test-results/zoom-${view.toLowerCase()}.png` });
    }
  } finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
