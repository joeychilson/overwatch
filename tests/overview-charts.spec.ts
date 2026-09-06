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
    await expect(page.getByText(/Not your subscription bill/)).toBeVisible();
    await page.getByRole("combobox", { name: "Date range" }).click();
    await page.getByRole("option", { name: "Last year", exact: true }).click();
    await expect(page.getByText(/Weekly totals/)).toBeVisible();
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
    if (coverage === "unknown")
      await expect(page.getByRole("status")).toContainText("Cost unavailable");
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
