import { test, expect } from "@playwright/test";
import { desktop, sessions } from "./desktop";
import type { SessionEvent } from "../src/lib/bindings";

const events: SessionEvent[] = Array.from({ length: 245 }, (_, index) => ({
  id: `match-${index}`,
  kind: "assistant",
  timestamp: Date.now() + index * 1000,
  text: `Review **search** result ${index}.\n\n\`\`\`ts\nconst search = ${index};\n\`\`\``,
  model: "gpt-6-astra",
  tool: null,
  output: null,
  durationMs: null,
  failed: null,
}));

test("match navigation crosses event pages and preserves keyboard focus and Markdown", async ({
  page,
}) => {
  await desktop(page, { events });
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page
    .locator('[data-row-id="session-0"]')
    .getByRole("button", { name: sessions[0].title, exact: true })
    .click();
  const search = page.getByRole("textbox", { name: "Search the entire transcript…" });
  await search.fill("search");
  await expect(page.getByText("1 of 245 matching events", { exact: true })).toBeVisible();
  const log = page.getByRole("region", { name: "Session conversation" });
  await expect(log.locator('[data-event-index="0"] strong mark')).toHaveText("search");
  await expect(log.locator('[data-event-index="0"] pre mark')).toHaveText("search");
  await expect(log.locator('[data-event-index="0"] pre')).toHaveText("const search = 0;\n");
  await page.screenshot({
    animations: "disabled",
    path: `test-results/reader-search-${test.info().project.name}.png`,
  });
  for (let i = 0; i < 105; i++) await search.press("Enter");
  await expect(page.getByText("106 of 245 matching events", { exact: true })).toBeVisible();
  await expect(log.locator('[data-event-index="105"]')).toBeInViewport();
  await expect(search).toBeFocused();
  await search.press("Shift+Enter");
  await expect(page.getByText("105 of 245 matching events", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous match", exact: true }).click();
  await expect(log.locator('[data-event-index="103"]')).toBeInViewport();
  await search.fill("");
  const timeline = page.getByRole("slider", { name: "Session activity timeline" });
  await timeline.focus();
  await page.keyboard.press("PageDown");
  await expect(log.locator('[data-event-index="100"]')).toBeFocused();
  await timeline.focus();
  await page.keyboard.press("PageUp");
  await expect(log.locator('[data-event-index="0"]')).toBeFocused();
});

test("expanded tool input and results highlight and copy the original payload", async ({
  page,
}) => {
  await desktop(page, { toolPreviews: true });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.clipboard = text;
        },
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page
    .locator('[data-row-id="session-0"]')
    .getByRole("button", { name: sessions[0].title, exact: true })
    .click();
  const search = page.getByRole("textbox", { name: "Search the entire transcript…" });
  await search.fill("Cannot find module");
  await expect(page.getByText("1 of 1 matching events", { exact: true })).toBeVisible();
  const log = page.getByRole("region", { name: "Session conversation" });
  await log.locator("summary").click();
  await expect(log.locator("pre mark")).toHaveText("Cannot find module");
  await page.screenshot({
    animations: "disabled",
    path: `test-results/reader-tool-copy-${test.info().project.name}.png`,
  });
  await log.getByRole("button", { name: "Copy tool input" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-clipboard", '{"command":"vp test run"}');
  await log.getByRole("button", { name: "Copy tool result" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute(
    "data-clipboard",
    "Starting tests\nError: Cannot find module './tool-preview'\nProcess exited with code 1",
  );
});

test("the activity heatmap has one Tab entry and arrow-key day/week navigation", async ({
  page,
}) => {
  await desktop(page);
  await page.goto("/");
  const grid = page.getByRole("group", { name: "Daily activity", exact: true });
  await expect(grid.locator('button[tabindex="0"]')).toHaveCount(1);
  const current = await grid.locator('button[tabindex="0"]').getAttribute("data-day-index");
  await grid.locator('button[tabindex="0"]').focus();
  await page.keyboard.press("ArrowLeft");
  await expect(grid.locator(`[data-day-index="${Number(current) - 7}"]`)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(grid.locator(`[data-day-index="${Number(current) - 8}"]`)).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await grid.evaluate((element) => element.contains(document.activeElement))).toBe(false);
  await grid.locator('button[tabindex="0"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
});
