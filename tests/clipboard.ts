/**
 * The clipboard as a test sees it: what the page writes is kept on the page,
 * since a test cannot read the system's.
 */
import { expect, type Page } from "@playwright/test";

/** Keep what the page puts on the clipboard, since a test cannot read the system's. */
export async function recordClipboard(page: Page) {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => void copied.push(text),
        write: async (items: ClipboardItem[]) => {
          for (const item of items) copied.push(await (await item.getType("text/plain")).text());
        },
      },
    });
  });
}

/** What the page last put on the clipboard. */
export async function lastCopied(page: Page) {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.length))
    .toBeGreaterThan(0);
  return page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1));
}
