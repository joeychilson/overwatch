import { test, expect } from "@playwright/test";
import { captureRuntimeErrors, desktop, longNames, sessions } from "./desktop";

test("missing durations remain unknown while recorded zero durations stay visible", async ({
  page,
}) => {
  await desktop(page, {
    sessions: [
      {
        ...sessions[0],
        startedAt: 0,
        tools: [
          { name: "unknown", calls: 1, completed: 1, failures: 0, timed: 0, durationMs: 0 },
          { name: "instant", calls: 1, completed: 1, failures: 0, timed: 1, durationMs: 0 },
          { name: "measured", calls: 1, completed: 1, failures: 0, timed: 1, durationMs: 600 },
        ],
      },
    ],
  });
  await page.goto("/");
  await expect(page.getByText("longest session", { exact: false })).toContainText(
    "— longest session",
  );
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: sessions[0].title, exact: true }).click();
  await expect(
    page
      .locator("p")
      .filter({ hasText: /^Elapsed$/ })
      .locator(".."),
  ).toContainText("—");
  await page.getByRole("button", { name: "Tool calls breakdown" }).click();
  const tools = page.getByRole("table", { name: "Session tool activity" });
  await expect(
    tools.getByRole("row").filter({ hasText: "unknown" }).getByRole("cell").last(),
  ).toHaveText("—");
  await expect(
    tools.getByRole("row").filter({ hasText: "instant" }).getByRole("cell").last(),
  ).toHaveText("0 ms");
  await expect(
    tools.getByRole("row").filter({ hasText: "measured" }).getByRole("cell").last(),
  ).toHaveText("600 ms");
});

test("continuous session view exposes counts, source opening, and timeline navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.text().includes("flushSync")) errors.push(message.text());
  });
  await captureRuntimeErrors(page);
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page
    .getByRole("button", { name: "Rebuild the session search experience", exact: true })
    .first()
    .click();
  const conversation = page.getByRole("region", { name: "Session conversation" });
  const timeline = page.getByRole("slider", { name: "Session activity timeline" });
  await expect(conversation).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(timeline).toBeVisible();
  for (const dark of [true, false]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value), dark);
    await page.setViewportSize({ width: 900, height: 640 });
    const tokens = page.getByRole("button", { name: "Tokens breakdown" });
    await tokens.click();
    const breakdown = page.getByRole("dialog", { name: "Tokens breakdown" });
    await expect(breakdown.getByText("Uncached input", { exact: true })).toBeVisible();
    await expect(breakdown.getByText("API equivalent", { exact: true })).toBeVisible();
    await expect(breakdown.getByText("Reasoning · included in output")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(breakdown).toBeHidden();
    await expect(tokens).toBeFocused();
    await page.getByRole("button", { name: "Tool calls breakdown" }).click();
    const tools = page.getByRole("dialog", { name: "Tool calls breakdown" });
    await expect(tools.getByRole("table", { name: "Session tool activity" })).toBeVisible();
    const box = await tools.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(900);
    await tools.getByRole("button", { name: "Close breakdown" }).click();
  }
  await expect(page.locator("summary").filter({ hasText: /Timeline|Session details/ })).toHaveCount(
    0,
  );
  await expect(page.getByText("Messages", { exact: true })).toBeVisible();
  await expect(page.getByText("Compactions", { exact: true })).toBeVisible();
  await expect(conversation).toBeVisible();
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(conversation.locator('[data-event-index="19999"]')).toBeFocused();
  await expect(conversation.locator('[data-event-index="19999"]')).toBeInViewport();
  await page.getByRole("button", { name: /Open source ·/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-opened-session-source", /.+/);
  await expect(timeline).toBeVisible();
  await timeline.focus();
  await page.keyboard.press("Home");
  await expect(conversation.locator('[data-event-index="0"]')).toBeFocused();
  await expect(conversation.locator('[data-event-index="0"]')).toBeInViewport();
  const search = page.getByRole("textbox", { name: "Search the entire transcript…" });
  await search.fill("final searchable needle");
  await expect(page.getByText("The final searchable needle", { exact: true })).toBeVisible();
  await timeline.click({ position: { x: 2, y: 12 } });
  await expect(search).toHaveValue("");
  await expect(conversation.locator('[data-event-index="0"]')).toBeFocused();
  expect(
    await page
      .locator('[data-slot="page-scroll"]')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  expect(errors).toEqual([]);
  expect(await page.locator("html").getAttribute("data-runtime-errors")).toBeNull();
});

test("long session titles clamp to two lines and expand with the keyboard", async ({ page }) => {
  await desktop(page, { longNames: true });
  await page.goto("/");
  await page.setViewportSize({ width: 900, height: 640 });
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search sessions, projects, or models…" })
    .fill(longNames.session);
  await page.getByRole("button", { name: longNames.session, exact: true }).click();
  const title = page.getByRole("heading", { level: 1 }).getByRole("button");
  await expect(title).toHaveAttribute("title", longNames.session);
  await expect(title).toHaveAttribute("aria-expanded", "false");
  const collapsed = await title.boundingBox();
  expect(collapsed!.height).toBeLessThanOrEqual(66);
  await title.focus();
  await page.keyboard.press("Enter");
  await expect(title).toHaveAttribute("aria-expanded", "true");
  expect((await title.boundingBox())!.height).toBeGreaterThan(collapsed!.height);
  await page.keyboard.press("Enter");
  await expect(title).toHaveAttribute("aria-expanded", "false");
  expect(
    await page
      .locator('[data-slot="page-scroll"]')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test("session model names remain searchable by name and original identifier", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search sessions, projects, or models…" });
  await search.fill("GPT-6 Astra");
  const table = page.getByRole("table", { name: "Sessions", exact: true });
  await expect(table.getByText("GPT-6 Astra", { exact: false }).first()).toBeVisible();
  const summary = page.getByText("16 sessions", { exact: true });
  await expect(summary).toBeVisible();
  await search.fill("");
  await expect(page.getByText("48 sessions", { exact: true })).toBeVisible();
  await search.fill("gpt-6-astra");
  await expect(summary).toBeVisible();
  await table
    .getByRole("button", { name: "Rebuild the session search experience", exact: true })
    .first()
    .click();
  const label = page.locator('span[title="gpt-6-astra"]');
  await expect(label).toHaveText("GPT-6 Astra");
  await page.getByRole("button", { name: /Search anything/ }).click();
  await page.getByRole("combobox", { name: "Search pages and sessions" }).fill("GPT-6 Astra");
  await expect(page.getByRole("option").first()).toContainText(
    "Rebuild the session search experience",
  );
});

for (const missing of ["all", "mixed"] as const) {
  test(`timeline preserves navigation with ${missing} timestamps missing`, async ({ page }) => {
    await desktop(page, { undatedEvents: missing });
    await page.goto("/");
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    const row = page.getByRole("table", { name: "Sessions", exact: true });
    await expect(row.getByText("Not recorded", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Rebuild the session search experience", exact: true })
      .click();
    await expect(page.getByText("Time unknown", { exact: true }).first()).toBeVisible();
    const timeline = page.getByRole("slider", { name: "Session activity timeline" });
    await expect(timeline).toHaveAttribute("aria-valuetext", /event order/);
    await expect(
      page.getByText("Spacing does not represent elapsed time.", { exact: false }),
    ).toBeVisible();
    const conversation = page.getByRole("region", { name: "Session conversation" });
    await timeline.focus();
    await page.keyboard.press("End");
    await expect(conversation.locator('[data-event-index="19999"]')).toBeFocused();
    await timeline.focus();
    await page.keyboard.press("Home");
    await expect(conversation.locator('[data-event-index="0"]')).toBeFocused();
    await expect(conversation.locator('[data-event-index="0"]')).toContainText("Time unknown");
    await page.locator('[data-slot="page-scroll"]').evaluate((element) => (element.scrollTop = 0));
  });
}
