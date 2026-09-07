import { test, expect } from "@playwright/test";
import { captureRuntimeErrors, desktop } from "./desktop";

test("overview, navigation, sorting, saved models, and comparison", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await desktop(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByText("Total tokens", { exact: true })).toBeVisible();
  const piIcon = page.getByRole("button", { name: "Pi", exact: true }).locator("img");
  await expect(piIcon).toHaveAttribute("src", "/logos/pi.svg");
  await expect(piIcon).toHaveCSS("scale", "0.75");
  await expect
    .poll(() =>
      piIcon.evaluate(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/overview.png", fullPage: true });
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: "Pricing catalog", exact: true }).click();
  await expect(page.getByRole("table", { name: "Model catalog" })).toBeVisible();
  await page.getByRole("button", { name: "Save GPT-6 Astra", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).click();
  await expect(page.getByRole("button", { name: "GPT-6 Astra", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Claude Opus 5", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "All models", exact: true }).click();
  await page.getByRole("checkbox", { name: "Compare GPT-6 Astra from OpenAI" }).click();
  await page.getByRole("checkbox", { name: "Compare Claude Opus 5 from Anthropic" }).click();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Cost calculator");
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Tool activity", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("invalid catalog falls back offline and a failed refresh keeps valid models", async ({
  page,
}) => {
  await desktop(page, { invalidCatalog: true });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Using the offline catalog");
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: "Pricing catalog", exact: true }).click();
  await expect(page.getByRole("button", { name: "GPT-6 Astra", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh catalog", exact: true }).click();
  await expect(
    page.getByText("The models.dev catalog failed validation at lab.models.broken.cost.input.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "GPT-6 Astra", exact: true })).toBeVisible();
});
test("long transcript scrolling, quick jumps, timeline, and safe Markdown", async ({ page }) => {
  const remote: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("invalid.example")) remote.push(request.url());
  });
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page
    .getByRole("button", { name: "Rebuild the session search experience", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("Can you improve the session search?", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".shj").first()).toBeVisible();
  await expect(page.locator(".prose img")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Search sessions, projects, or models…" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Previous 100" })).toHaveCount(0);
  const log = page.getByRole("region", { name: "Session conversation" });
  await log.locator('[data-event-index="2"] summary').click();
  await expect(log.locator('[data-event-index="2"] details')).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(page.getByText("The final searchable needle", { exact: true })).toBeVisible();
  await expect(log.locator('[data-event-index="19999"]')).toBeFocused();
  expect(await log.locator("[data-event-index]").count()).toBeLessThan(80);
  await page.getByRole("button", { name: "Jump to start" }).click();
  await expect(
    page.getByText("Can you improve the session search?", { exact: true }),
  ).toBeVisible();
  await expect(log.locator('[data-event-index="2"] details')).toHaveAttribute("open", "");
  const viewport = page.locator('[data-slot="page-scroll"]');
  await viewport.evaluate((element) => {
    element.scrollTop = 18000;
  });
  await expect
    .poll(async () =>
      Number(await log.locator("[data-event-index]").first().getAttribute("data-event-index")),
    )
    .toBeGreaterThan(100);
  await expect(log.getByLabel("Loading event")).toHaveCount(0);
  expect(await log.locator("[data-event-index]").count()).toBeLessThan(80);
  await page
    .getByRole("textbox", { name: "Search the entire transcript…" })
    .fill("final searchable needle");
  await expect(page.getByText("The final searchable needle", { exact: true })).toBeVisible();
  await page.getByRole("slider", { name: "Session activity timeline" }).focus();
  await page.keyboard.press("End");
  await expect(page.getByText("The final searchable needle", { exact: true })).toBeVisible();
  await expect(log.locator('[data-event-index="19999"]')).toBeFocused();
  await page.screenshot({ path: "test-results/session-latest.png", fullPage: false });
  expect(remote).toEqual([]);
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
});
test("session navigation preserves list filters, sorting, scroll position, and focus", async ({
  page,
}) => {
  await captureRuntimeErrors(page);
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search sessions, projects, or models…" });
  await search.fill("overwatch");
  const table = page.getByRole("table", { name: "Sessions", exact: true });
  await table.getByRole("button", { name: "Tokens", exact: true }).click();
  await expect(table.getByRole("columnheader", { name: "Tokens" })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  const titles = await table.locator("tbody button").allTextContents();
  await table.locator("tbody tr[data-row-id]").first().getByRole("cell").nth(2).click();
  await expect(page.getByRole("heading", { level: 1, name: titles[0], exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Session navigation" })).toContainText(
    "1 of 32",
  );
  await expect(page.getByRole("button", { name: "Previous session" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Project scope" })).toHaveCount(0);
  await page.getByRole("button", { name: "Next session" }).click();
  await expect(page.getByRole("heading", { level: 1, name: titles[1], exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Session navigation" })).toContainText(
    "2 of 32",
  );
  await page.getByRole("button", { name: "Previous session" }).click();
  await expect(page.getByRole("heading", { level: 1, name: titles[0], exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect(search).toHaveValue("overwatch");
  await expect(table.getByRole("columnheader", { name: "Tokens" })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  const viewport = page.locator('[data-slot="page-scroll"]');
  await page.setViewportSize({ width: 900, height: 640 });
  await viewport.evaluate((element) => {
    element.scrollTop = 500;
  });
  const row = table.locator("tbody tr[data-row-id]").nth(12);
  await row.scrollIntoViewIfNeeded();
  const id = await row.getAttribute("data-row-id");
  const pageTop = await viewport.evaluate((element) => element.scrollTop);
  await row.getByRole("cell").nth(2).click();
  await expect(page.getByRole("navigation", { name: "Session navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(pageTop);
  await expect(table.locator(`[data-row-id="${id}"] button`)).toBeFocused();
  expect(await page.locator("html").getAttribute("data-runtime-errors")).toBeNull();
});
test("a failed transcript section can be retried without losing session navigation", async ({
  page,
}) => {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("flushSync")) warnings.push(message.text());
  });
  await desktop(page, { failEventsAt: 19900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page
    .getByRole("button", { name: "Rebuild the session search experience", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture transcript read failed");
  await expect(page.getByRole("button", { name: "Back to sessions" })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("The final searchable needle", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(warnings).toEqual([]);
});
test("empty transcripts have an explicit empty state and disabled jumps", async ({ page }) => {
  await desktop(page, { emptyTranscript: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page
    .getByRole("button", { name: "Rebuild the session search experience", exact: true })
    .first()
    .click();
  await expect(page.getByText("No events have been recorded yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Jump to start" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Search the entire transcript…" }).fill("missing");
  await expect(page.getByText("No matching events.")).toBeVisible();
});
test("provider failures keep the last reading and failed source edits keep the draft", async ({
  page,
}) => {
  await desktop(page, { failRefresh: true, failSave: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Subscriptions", exact: true }).click();
  await page.getByRole("button", { name: "Refresh usage", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture provider unavailable");
  await expect(page.getByRole("meter", { name: "5 hour quota remaining" })).toHaveAttribute(
    "aria-valuenow",
    "58",
  );
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByRole("textbox", { name: "Codex source folder" }).fill("/new/codex");
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  await page.getByRole("button", { name: "Change folder", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Fixture settings write failed",
  );
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Codex source folder" })).toHaveValue(
    "/new/codex",
  );
});
test("command search, light theme, source selection and collapsed navigation", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search pages and sessions" }).fill("Connections");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("button", { name: "Choose Codex folder" }).click();
  await expect(page.getByRole("textbox", { name: "Codex source folder" })).toHaveValue(
    "/fixtures/chosen",
  );
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  await page.getByRole("button", { name: "Change folder", exact: true }).click();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/overview-light.png", fullPage: true });
});

test("partial history stays usable and cache repair has a discoverable recovery action", async ({
  page,
}) => {
  await desktop(page, { cachedSummaryIssue: true });
  await page.goto("/");
  await expect(page.getByText("Total tokens", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Totals may be incomplete/ }).click();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await expect(
    page.getByText(/An unreadable cached session is excluded from totals/),
  ).toBeVisible();
  await page.screenshot({ path: `test-results/cache-recovery-${test.info().project.name}.png` });
  await page.getByRole("button", { name: "Rescan sources", exact: true }).click();
  await expect(page.getByText(/An unreadable cached session is excluded from totals/)).toHaveCount(
    0,
  );
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /Totals may be incomplete/ })).toHaveCount(0);
  await expect(page.getByText("Total tokens", { exact: true })).toBeVisible();
});
