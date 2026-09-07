import { expect, test } from "@playwright/test";
import { desktop } from "./desktop";

test("source replacement explains its impact and cancel preserves the original", async ({
  page,
}) => {
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Codex source folder" })
    .fill("/Users/example/.codex-new");
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("16 cached sessions");
  await expect(dialog).toContainText("10 saved allowance readings");
  await expect(dialog).toContainText("Original history files will stay untouched.");
  await page.screenshot({ path: `test-results/source-preview-${test.info().project.name}.png` });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Codex source folder" })).toHaveValue(
    "/fixtures/codex",
  );
});

test("disabling a source needs no destructive confirmation", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByRole("switch", { name: "Enable Codex history" }).click();
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Source disabled", { exact: true })).toBeVisible();
});
