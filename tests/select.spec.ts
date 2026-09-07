import { test, expect } from "@playwright/test";
import { desktop } from "./desktop";

test("header dropdowns open below their triggers with every option visible", async ({ page }) => {
  await desktop(page);
  await page.setViewportSize({ width: 900, height: 640 });
  await page.goto("/");
  for (const [label, names] of [
    ["Date range", ["Last 7 days", "Last 30 days", "Last 90 days", "Last year"]],
    [
      "Agent scope",
      ["All agents", "Codex", "Claude Code", "OpenCode", "Pi", "Grok Build", "Antigravity"],
    ],
  ] as const) {
    const trigger = page.getByRole("combobox", { name: label });
    await trigger.click();
    const popup = page.locator('[data-slot="select-content"][data-open]');
    await expect(popup).toBeVisible();
    await expect
      .poll(async () => {
        const control = await trigger.boundingBox();
        const menu = await popup.boundingBox();
        return (
          !!control &&
          !!menu &&
          menu.y >= control.y + control.height + 4 &&
          menu.y + menu.height <= 640
        );
      })
      .toBe(true);
    for (const name of names)
      await expect(page.getByRole("option", { name, exact: true })).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
  const range = page.getByRole("combobox", { name: "Date range" });
  await range.click();
  await page.getByRole("option", { name: "Last 7 days", exact: true }).click();
  await expect(range.locator('[data-slot="select-value"]')).toHaveText("Last 7 days");
  await expect(range).toBeFocused();
  await range.press("ArrowDown");
  await expect(page.locator('[data-slot="select-content"][data-open]')).toBeVisible();
  // The popup becomes visible before keyboard focus reaches the selected option.
  await expect(page.getByRole("option", { name: "Last 7 days", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Last 30 days", exact: true })).toHaveAttribute(
    "data-highlighted",
    "",
  );
  await expect(page.getByRole("option", { name: "Last 30 days", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(range.locator('[data-slot="select-value"]')).toHaveText("Last 30 days");
});
