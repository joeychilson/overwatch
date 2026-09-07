import { test, expect } from "@playwright/test";
import { desktop } from "./desktop";

test("usage charts switch grouping and metric, retain provider colors, and fit small windows", async ({
  page,
}) => {
  await desktop(page);
  await page.goto("/");
  await page.setViewportSize({ width: 900, height: 640 });
  for (const dark of [true, false]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value), dark);
    const chart = page.locator('[aria-label="Usage over time by agent"]');
    await expect(chart.locator(".recharts-bar").first()).toBeVisible();
    await expect(chart.locator(".recharts-area")).toHaveCount(0);
    await page.getByRole("combobox", { name: "Group usage by" }).click();
    await page.getByRole("option", { name: "By model", exact: true }).click();
    await expect(page.locator('[aria-label="Usage breakdown"]')).toContainText("GPT-6 Astra");
    await page.getByRole("button", { name: "API equivalent", exact: true }).click();
    await expect(page.locator('[aria-label="Usage breakdown"]')).toContainText("$");
    await expect(page.getByRole("button", { name: "API equivalent", exact: true })).toHaveAttribute(
      "title",
      /not your subscription bill/,
    );
    await page.getByRole("combobox", { name: "Date range" }).click();
    await page.getByRole("option", { name: "Last year", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Date range" })).toContainText("Last year");
    await expect(
      page.getByLabel("Usage over time by model", { exact: true }).locator(".recharts-bar").first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Tokens", exact: true }).first().click();
    await page.getByRole("combobox", { name: "Group usage by" }).click();
    await page.getByRole("option", { name: "By agent", exact: true }).click();
    expect(
      await page
        .locator('[data-slot="page-scroll"]')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  }
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const ranking = page.getByRole("table", { name: "Model usage", exact: true });
  await expect(ranking.getByText("OpenAI", { exact: true }).first()).toBeVisible();
  await expect(ranking.getByText("Anthropic", { exact: true })).toBeVisible();
});

test("activity tooltip supports hover, keyboard, and session navigation", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  const cell = page.getByRole("button", { name: /tokens$/ }).last();
  await cell.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip.getByText("Daily tokens", { exact: true })).toBeVisible();
  await expect(cell).not.toHaveAttribute("title");
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await page.mouse.move(0, 0);
  await cell.focus();
  await expect(tooltip).toBeVisible();
  await expect(cell).toHaveAttribute("aria-describedby", (await tooltip.getAttribute("id")) ?? "");
  await cell.click();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
});

for (const coverage of ["unknown", "zero", "mixed"] as const) {
  test(`cost coverage distinguishes ${coverage} costs in overview and session details`, async ({
    page,
  }) => {
    await desktop(page, { costCoverage: coverage });
    await page.goto("/");
    const metric = page.getByText("API equivalent", { exact: true }).first().locator("..");
    if (coverage === "unknown") {
      await expect(metric).toContainText("—");
      await expect(metric).toContainText("responses unpriced");
    } else if (coverage === "zero") {
      await expect(metric).toContainText("$0.00");
      await expect(metric).not.toContainText("unpriced");
    } else {
      await expect(metric).toContainText("known subtotal");
    }
    await page.getByRole("button", { name: "API equivalent", exact: true }).click();
    const breakdown = page.getByLabel("Usage breakdown");
    for (const agent of ["Codex", "Claude Code", "OpenCode"]) {
      const row = breakdown.locator("div").filter({ has: page.getByText(agent, { exact: true }) });
      await expect(row).toBeVisible();
      if (coverage === "zero") await expect(row).toContainText("$0.00");
      if (coverage === "unknown") await expect(row).toContainText("—");
    }
    if (coverage === "unknown")
      await expect(page.getByRole("status").filter({ hasText: "Cost unavailable" })).toBeVisible();
    if (coverage === "mixed")
      await expect(page.getByText(/USD · .* recorded · .* estimated/)).toBeVisible();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.screenshot({ path: `test-results/cost-${coverage}.png` });
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await page
      .getByRole("button", { name: "Rebuild the session search experience", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "Tokens breakdown" }).click();
    const detail = page.getByRole("dialog", { name: "Tokens breakdown" });
    if (coverage === "unknown") await expect(detail).toContainText("responses unpriced");
    else if (coverage === "zero") await expect(detail).not.toContainText("unpriced");
    await expect(detail).toContainText("estimated (USD)");
  });
}

test("session counts follow response dates and empty periods differ from empty scopes", async ({
  page,
}) => {
  await desktop(page, { periodMismatch: true });
  await page.goto("/");
  const metric = page.getByText("Sessions with usage", { exact: true }).locator("..");
  await expect(metric).toContainText("1 project with recorded responses");
  await page.getByRole("combobox", { name: "Date range" }).click();
  await page.getByRole("option", { name: "Last year", exact: true }).click();
  await expect(metric.locator("p").nth(1)).toHaveText("2");
  await page.getByRole("combobox", { name: "Date range" }).click();
  await page.getByRole("option", { name: "Last 7 days", exact: true }).click();
  await expect(metric.locator("p").nth(1)).toHaveText("1");
  await page.getByRole("combobox", { name: "Agent scope" }).click();
  await page.getByRole("option", { name: "Claude Code", exact: true }).click();
  await expect(metric.locator("p").nth(1)).toHaveText("0");
  await expect(page.getByText(/No model responses recorded in this period/)).toBeVisible();
  await page.getByRole("combobox", { name: "Agent scope" }).click();
  await page.getByRole("option", { name: "Pi", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No sessions match this scope" })).toBeVisible();
  await page.getByRole("button", { name: "Clear project and agent filters" }).click();
  await expect(metric.locator("p").nth(1)).toHaveText("1");
});

test("undated responses remain inspectable without appearing in calendar totals", async ({
  page,
}) => {
  await desktop(page, { undatedUsage: true });
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "no usable timestamp" })).toBeVisible();
  await expect(
    page.getByText("No model responses recorded in this period.", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: `test-results/undated-usage-${test.info().project.name}.png` });
  await page.getByRole("button", { name: "Review sessions", exact: true }).click();
  await page
    .getByRole("button", { name: "Rebuild the session search experience", exact: true })
    .click();
  await page.getByRole("button", { name: "Tokens breakdown" }).click();
  const details = page.getByRole("dialog", { name: "Tokens breakdown" });
  await expect(details.getByText("without usable timestamps", { exact: false })).toBeVisible();
  await expect(details.getByText("Uncached input", { exact: true })).toBeVisible();
});

test("session exports leave unknown dates and elapsed time blank", async ({ page }) => {
  await desktop(page, { undatedEvents: "all" });
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const exported = await page.locator("html").getAttribute("data-exported-file");
  expect(JSON.parse(exported!).content).not.toContain("1970-01-01");
  expect(JSON.parse(exported!).content).toContain('"","",""');
});

test("tool rankings show contributing agents and follow the agent filter", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  const tools = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Most used tools", exact: true }),
  });
  const exec = tools.getByRole("button", { name: "Find exec_command in sessions", exact: true });
  await expect(exec).toContainText("Codex · Claude Code · OpenCode");
  await expect(exec).not.toContainText("Antigravity");
  await expect(exec).toHaveAccessibleDescription(/552 Codex · Claude Code · OpenCode/);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await tools
    .locator("..")
    .screenshot({ path: `test-results/charts-with-agents-${test.info().project.name}.png` });
  await page.getByRole("combobox", { name: "Agent scope" }).click();
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  await expect(exec).toContainText("Codex");
  await expect(exec).not.toContainText("Claude Code");
  await expect(exec).not.toContainText("OpenCode");
  await exec.click();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
});
