import { test, expect, type Locator } from "@playwright/test";
import { desktop, longNames } from "./desktop";

async function columns(table: Locator) {
  return table.locator("thead th").evaluateAll((cells) =>
    cells.map((cell) => {
      const box = cell.getBoundingClientRect();
      const left = cell.closest("table")!.getBoundingClientRect().left;
      return { left: Math.round(box.left - left), width: Math.round(box.width) };
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await desktop(page, { longNames: true });
  await page.goto("/");
});

test("row highlights have rounded outer corners on neutral surfaces in both themes", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: "Pricing catalog", exact: true }).click();
  const row = page
    .getByRole("table", { name: "Model catalog", exact: true })
    .locator("tbody tr[data-row-id]")
    .first();
  const first = row.locator("td").first();
  const last = row.locator("td").last();
  for (const dark of [false, true]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value), dark);
    await row.hover();
    await expect(first).toHaveCSS("border-top-left-radius", "10px");
    await expect(first).toHaveCSS("border-bottom-left-radius", "10px");
    await expect(last).toHaveCSS("border-top-right-radius", "10px");
    await expect(last).toHaveCSS("border-bottom-right-radius", "10px");
    await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const highlight = await first.evaluate((cell) => getComputedStyle(cell).backgroundColor);
    expect(highlight).not.toBe("rgba(0, 0, 0, 0)");
    await expect(last).toHaveCSS("background-color", highlight);
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      dark ? "rgb(23, 23, 23)" : "rgb(250, 250, 250)",
    );
    await page.mouse.move(0, 0);
    await row.getByRole("button").first().focus();
    await expect(first).toHaveCSS("background-color", highlight);
    await expect(last).toHaveCSS("background-color", highlight);
  }
});

test("paged session columns and row heights stay stable while scrolling past long names", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  const table = page.getByRole("table", { name: "Sessions", exact: true });
  await expect(table.locator("tbody tr[data-row-id]").first()).toBeVisible();
  const initial = await columns(table);
  await expect(
    table.getByRole("button", { name: longNames.session, exact: true }),
  ).not.toBeInViewport();
  const viewport = page.locator('[data-slot="page-scroll"]');
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const name = table.getByRole("button", { name: longNames.session, exact: true });
  await expect(name).toBeVisible();
  await expect.poll(() => columns(table)).toEqual(initial);
  await expect(name).toHaveAttribute("title", longNames.session);
  expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(
    await table
      .locator("tbody tr[data-row-id]")
      .evaluateAll((rows) =>
        rows.every((row) => Math.abs(row.getBoundingClientRect().height - 60) < 1),
      ),
  ).toBe(true);
  await page
    .getByRole("textbox", { name: "Search sessions, projects, or models…" })
    .fill("Investigate session indexing");
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(1);
  await expect.poll(() => columns(table)).toEqual(initial);
  await page.setViewportSize({ width: 900, height: 640 });
  expect(
    await table.evaluate((element) => element.scrollWidth > element.parentElement!.clientWidth),
  ).toBe(true);
  expect(
    await page
      .locator('[data-slot="page-scroll"]')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test("overview tool links open filtered sessions with mouse and keyboard", async ({ page }) => {
  const tool = page.getByRole("button", { name: "Find exec_command in sessions", exact: true });
  await tool.click();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear tool filter" })).toBeVisible();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await tool.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear tool filter" }).click();
  await expect(page.getByRole("button", { name: "Clear tool filter" })).toHaveCount(0);
});

test("model names do not resize catalog columns and comparison controls remain independent of row clicks", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: "Pricing catalog", exact: true }).click();
  const table = page.getByRole("table", { name: "Model catalog", exact: true });
  const name = table.getByRole("button", { name: longNames.model, exact: true });
  await expect(name).toBeVisible();
  const initial = await columns(table);
  await expect(name).toHaveAttribute("title", longNames.model);
  expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await table.getByRole("button", { name: "Save GPT-6 Astra", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).click();
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(1);
  await expect.poll(() => columns(table)).toEqual(initial);
  await page.getByRole("button", { name: "All models", exact: true }).click();
  await table
    .getByRole("checkbox", {
      name: `Compare ${longNames.model} from ${longNames.provider}`,
      exact: true,
    })
    .click();
  await table
    .getByRole("checkbox", { name: "Compare GPT-6 Astra from OpenAI", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const comparison = page.getByRole("table", { name: "Model comparison", exact: true });
  await expect(comparison).toBeVisible();
  const layout = await columns(comparison);
  expect(layout[1].width).toBe(layout[2].width);
  await expect(comparison.getByText(longNames.model, { exact: true })).toHaveAttribute(
    "title",
    longNames.model,
  );
});
