import { test, expect } from "@playwright/test";
import { desktop, sessions as fixtureSessions } from "./desktop";

test("model analysis combines providers, preserves their prices and filters contributing sessions", async ({
  page,
}) => {
  await desktop(page, { crossProvider: true });
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Model usage", exact: true })).toHaveCount(0);
  const overviewModels = page.getByRole("heading", { name: "Most used models", exact: true });
  await expect(overviewModels).toBeAttached();
  await overviewModels.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: `test-results/overview-model-list-${test.info().project.name}.png`,
  });
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const table = page.getByRole("table", { name: "Model usage", exact: true });
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(1);
  await expect(table).toContainText("6M");
  await expect(table).toContainText("$140.00");
  for (const provider of ["OpenAI", "Azure", "OpenRouter"])
    await expect(table).toContainText(provider);
  await table.getByRole("button", { name: "GPT-6 Astra", exact: true }).click();
  const dialog = page.locator('[data-slot="page-scroll"]');
  await expect(page.getByRole("heading", { name: "GPT-6 Astra", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Group usage by" }).click();
  await page.getByRole("option", { name: "By model", exact: true }).click();
  await expect(page.locator('[aria-label="Usage breakdown"]')).toContainText("GPT-6 Astra6M");
  await page.getByRole("combobox", { name: "Group usage by" }).click();
  await page.getByRole("option", { name: "By provider", exact: true }).click();
  await expect(page.locator('[aria-label="Usage breakdown"]')).toContainText("OpenRouter");

  const sources = dialog.getByRole("table", { name: "Model provider costs" });
  await expect(sources.getByRole("row").filter({ hasText: "Azure" })).toContainText("$40.00");
  await expect(sources.getByRole("row").filter({ hasText: "OpenRouter" })).toContainText("$90.00");
  const sessions = dialog.getByRole("table", { name: "Model contributing sessions" });
  await expect(sessions.locator("tbody tr[data-row-id]")).toHaveCount(3);
  await expect(sessions.locator("tbody img")).toHaveCount(3);
  await expect(sessions.getByRole("columnheader", { name: "Project" })).toBeVisible();
  await expect(sources.locator('img[src="/logos/openai.svg"]')).toHaveCount(1);
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 1000 });
    await sessions.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: `test-results/model-sections-${width}-${test.info().project.name}.png`,
    });
    expect(
      await sources.evaluate(
        (element) => element.scrollWidth <= element.parentElement!.clientWidth,
      ),
    ).toBe(true);
  }
  await dialog.getByRole("combobox", { name: "Model agent filter" }).click();
  await page.getByRole("option", { name: "Pi", exact: true }).click();
  await expect(sessions.locator("tbody tr[data-row-id]")).toHaveCount(1);
  await expect(sources).toContainText("$40.00");
  await dialog.getByRole("combobox", { name: "Model provider filter" }).click();
  await page.getByRole("option", { name: "OpenAI", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "No results", exact: true })).toHaveCount(2);
  await dialog.getByRole("combobox", { name: "Model agent filter" }).click();
  await page.getByRole("option", { name: "All agents", exact: true }).click();
  await expect(sessions.locator("tbody tr[data-row-id]")).toHaveCount(1);
  await expect(sources).toContainText("$10.00");
  await page.setViewportSize({ width: 900, height: 700 });
  await expect
    .poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await dialog.screenshot({ path: `test-results/model-analysis-${test.info().project.name}.png` });
  await sessions
    .getByRole("button", { name: "Rebuild the session search experience", exact: true })
    .click();
  await expect(dialog.getByRole("region", { name: "Session conversation" })).toBeVisible();
  await dialog.getByRole("button", { name: "Back to model analysis" }).click();
  await expect(dialog.getByRole("combobox", { name: "Model provider filter" })).toContainText(
    "OpenAI",
  );
  await expect(sources).toContainText("$10.00");
  await expect(
    sessions.getByRole("button", { name: "Rebuild the session search experience", exact: true }),
  ).toBeFocused();
});

test("model ranking search recovers from no results and details return keyboard focus", async ({
  page,
}) => {
  await desktop(page);
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Model usage", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Find used models or providers…" });
  await search.fill("not-a-model");
  await expect(page.getByRole("heading", { name: "No matching models" })).toBeVisible();
  await search.fill("GPT-6");
  const table = page.getByRole("table", { name: "Model usage", exact: true });
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(1);
  const model = table.getByRole("button", { name: "GPT-6 Astra", exact: true });
  await model.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "GPT-6 Astra", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to models", exact: true }).click();
  await expect(model).toBeFocused();
  await expect(search).toHaveValue("GPT-6");
  await model.click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Models", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(table).toBeVisible();
});

test("all model rows remain reachable and unmatched offerings stay explicit", async ({ page }) => {
  await desktop(page, { manyModels: true });
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Model usage", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const table = page.getByRole("table", { name: "Model usage", exact: true });
  await expect(table.locator("tbody tr[data-row-id]").first()).toBeVisible();
  expect(await table.locator("tbody tr[data-row-id]").count()).toBeLessThan(80);
  await page.locator('[data-slot="page-scroll"]').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const last = table.getByRole("button", { name: "fixture-model-079", exact: true });
  await expect(last).toBeVisible();
  await last.click();
  const dialog = page.locator('[data-slot="page-scroll"]');
  await expect(page.getByRole("heading", { name: "fixture-model-079", exact: true })).toBeVisible();
  await expect(dialog).toContainText("This identity is not verified across providers");
  await expect(dialog).toContainText("1 response unpriced");
  await page.setViewportSize({ width: 640, height: 800 });
  await dialog.screenshot({
    path: `test-results/model-unresolved-${test.info().project.name}.png`,
  });
  await expect
    .poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await dialog.screenshot({
    path: `test-results/model-unresolved-${test.info().project.name}.png`,
  });
  await page.getByRole("button", { name: "Back to models", exact: true }).click();
  await expect(last).toBeVisible();
  await expect(last).toBeFocused();
});

test("model date changes retain the data page and recover to a filtered list", async ({ page }) => {
  await desktop(page, { periodMismatch: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("combobox", { name: "Date range", exact: true }).click();
  await page.getByRole("option", { name: "Last 90 days", exact: true }).click();
  const table = page.getByRole("table", { name: "Model usage", exact: true });
  await expect(table).toContainText("Claude Opus 5");
  await expect(page.getByRole("listbox")).toBeHidden();
  await page.screenshot({ path: `test-results/models-list-${test.info().project.name}.png` });
  await table.getByRole("button", { name: "Claude Opus 5", exact: true }).click();
  await page.getByRole("combobox", { name: "Date range", exact: true }).click();
  await page.getByRole("option", { name: "Last 7 days", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Claude Opus 5", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No results", exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Back to models", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Find used models or providers…" })).toBeFocused();
  await expect(table).not.toContainText("Claude Opus 5");
});

for (const input of ["mouse", "keyboard"] as const) {
  test(`Overview model links open details with ${input} and navigation scrolls away`, async ({
    page,
  }) => {
    await desktop(page, { crossProvider: true });
    await page.goto("/");
    await page.getByRole("combobox", { name: "Date range", exact: true }).click();
    await page.getByRole("option", { name: "Last 7 days", exact: true }).click();
    const link = page.getByRole("button", { name: "View GPT-6 Astra usage", exact: true });
    await link.scrollIntoViewIfNeeded();
    if (input === "mouse") await link.click();
    else {
      await link.focus();
      await page.keyboard.press("Enter");
    }
    await expect(page.getByRole("heading", { name: "GPT-6 Astra", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Date range", exact: true })).toContainText(
      "Last 7 days",
    );
    const scroll = page.locator('[data-slot="page-scroll"]');
    const back = page.getByRole("navigation", { name: "Model navigation", exact: true });
    await expect(back).toBeInViewport();
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(back).not.toBeInViewport();
    await expect(page.getByRole("table", { name: "Model contributing sessions" })).toBeInViewport();
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: `test-results/model-scroll-${input}-${test.info().project.name}.png`,
    });
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.getByRole("button", { name: "Back to models", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
    await expect(page.getByRole("table", { name: "Model usage", exact: true })).toContainText(
      "GPT-6 Astra",
    );
  });
}

test("model sessions scroll through multiple batches and restore the opened row", async ({
  page,
}) => {
  const sessions = Array.from({ length: 123 }, (_, index) => ({
    ...fixtureSessions[0],
    id: `model-page-${index}`,
    title: `Model session ${String(index).padStart(3, "0")}`,
    updatedAt: Date.now() - index * 1000,
  }));
  await desktop(page, { sessions });
  await page.goto("/");
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: "GPT-6 Astra", exact: true }).click();
  const table = page.getByRole("table", { name: "Model contributing sessions" });
  await table.scrollIntoViewIfNeeded();
  const scroll = table.locator("..");
  await expect(table.locator("tbody [data-row-id]").first()).toBeVisible();
  expect(await table.locator("tbody [data-row-id]").count()).toBeLessThan(50);
  const last = table.getByRole("button", { name: "Model session 122", exact: true });
  await expect
    .poll(async () => {
      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      return last.isVisible();
    })
    .toBe(true);
  const requests = JSON.parse(
    (await page.locator("html").getAttribute("data-history-requests")) ?? "[]",
  );
  expect(
    requests.some(
      (request: {
        command: string;
        args: { query: { usageOnly: boolean; offset: number; limit: number } };
      }) =>
        request.command === "get_sessions" &&
        request.args.query.usageOnly &&
        request.args.query.offset === 100 &&
        request.args.query.limit === 50,
    ),
  ).toBe(true);
  await last.click();
  await expect(page.getByRole("region", { name: "Session conversation" })).toBeVisible();
  await page.getByRole("button", { name: "Back to model analysis" }).click();
  await expect(last).toBeFocused();
  await expect(last).toBeVisible();
});
