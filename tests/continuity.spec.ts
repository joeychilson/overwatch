import { test, expect } from "@playwright/test";
import { desktop, sessions } from "./desktop";
import { initialWorkspace, workspaceKey } from "../src/lib/shell/workspace-state";
const history = Array.from({ length: 123 }, (_, index) => ({
  ...sessions[index % sessions.length],
  id: `restore-${index}`,
  title: `Restored history ${String(index).padStart(3, "0")}`,
  updatedAt: Date.now() - index * 1000,
}));

test("restart restores session pages, filters, sort and the reading position", async ({ page }) => {
  await desktop(page, { sessions: history });
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search sessions, projects, or models…" })
    .fill("Restored history");
  const table = page.getByRole("table", { name: "Sessions", exact: true });
  await table.getByRole("button", { name: "Session", exact: true }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await table.getByRole("button", { name: "Restored history 080", exact: true }).click();
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(page.locator('[data-event-index="19999"]')).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "{}").readers?.at(-1)?.index,
        workspaceKey,
      ),
    )
    .toBeGreaterThan(19980);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Restored history 080", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-event-index="19999"]')).toBeInViewport();
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect(
    page.getByRole("textbox", { name: "Search sessions, projects, or models…" }),
  ).toHaveValue("Restored history");
  await expect(page.getByRole("navigation", { name: "Session pages" })).toContainText(
    "51–100 of 123 sessions",
  );
  await expect(table.getByRole("columnheader", { name: "Session", exact: true })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await expect(
    table.getByRole("button", { name: "Restored history 080", exact: true }),
  ).toBeFocused();
});

test("back and forward restore view and query context without a history entry per keystroke", async ({
  page,
}) => {
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  const length = await page.evaluate(() => window.history.length);
  await page.getByRole("textbox", { name: "Search sessions, projects, or models…" }).fill("cache");
  await expect(page.getByRole("navigation", { name: "Session pages" })).toContainText("8 sessions");
  expect(await page.evaluate(() => window.history.length)).toBe(length);
  await page
    .getByRole("table", { name: "Sessions", exact: true })
    .getByRole("button", { name: "Fix cache accounting across providers", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Fix cache accounting across providers", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Search sessions, projects, or models…" }),
  ).toHaveValue("cache");
  await page.evaluate(() => window.history.forward());
  await expect(
    page.getByRole("heading", { name: "Fix cache accounting across providers", exact: true }),
  ).toBeVisible();
});

test("invalid saved data falls back and a removed session returns to its list", async ({
  page,
}) => {
  await desktop(page);
  await page.addInitScript(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), {
    key: workspaceKey,
    state: { ...initialWorkspace, route: { view: "sessions", id: "removed-session" } },
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to sessions" })).toHaveCount(0);
});

test("an unsupported saved workspace version falls back to Overview", async ({ page }) => {
  await desktop(page);
  await page.addInitScript((key) => localStorage.setItem(key, '{"version": 999}'), workspaceKey);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
});

test("model detail, ranking sort and search survive restart", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const table = page.getByRole("table", { name: "Model usage", exact: true });
  await table.getByRole("button", { name: "Model", exact: true }).click();
  await page.getByRole("textbox", { name: "Find used models or providers…" }).fill("GPT-6");
  await table.getByRole("button", { name: "GPT-6 Astra", exact: true }).click();
  await expect(page.getByRole("heading", { name: "GPT-6 Astra", exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "{}").route?.modelKey,
        workspaceKey,
      ),
    )
    .toBeTruthy();
  await page.reload();
  await expect(page.getByRole("heading", { name: "GPT-6 Astra", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to models", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Find used models or providers…" })).toHaveValue(
    "GPT-6",
  );
  await expect(table.getByRole("columnheader", { name: "Model", exact: true })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
});
