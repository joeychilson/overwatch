import { test, expect } from "@playwright/test";
import { desktop } from "./desktop";

test.beforeEach(async ({ page }) => {
  await desktop(page, { toolPreviews: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page
    .getByRole("button", { name: "Rebuild the session search experience", exact: true })
    .first()
    .click();
});

test("collapsed tool calls expose meaningful inputs and errors, and expand from the preview or keyboard", async ({
  page,
}) => {
  const log = page.getByRole("region", { name: "Session conversation" });
  await expect(log.locator("details[open]")).toHaveCount(0);
  const command = log.locator('[data-event-index="0"]');
  await expect(command.locator("summary")).toContainText(
    "rg 'useQuery|useVirtualizer' src --glob '*.tsx'",
  );
  await expect(log.locator('[data-event-index="1"] summary')).toContainText(
    "src/lib/components/session-log.tsx · lines 120–180",
  );
  await expect(log.locator('[data-event-index="2"] summary')).toContainText(
    "src/lib/components/session-log.tsx · 1 more file",
  );
  await expect(log.locator('[data-event-index="3"] summary')).toContainText(
    "eventPageOptions · src",
  );
  const failed = log.locator('[data-event-index="4"] summary');
  await expect(failed).toContainText("Failed");
  await expect(failed).toContainText("Error: Cannot find module './tool-preview'");
  const preview = command
    .locator("summary")
    .getByText("rg 'useQuery|useVirtualizer' src --glob '*.tsx'", { exact: true });
  await preview.click();
  await expect(command.locator("details")).toHaveAttribute("open", "");
  await expect(preview).toHaveCount(0);
  await expect(command.locator("pre").first()).toContainText('"yield_time_ms":1000');
  await expect(command.locator("pre").last()).toContainText("Process exited with code 0");
  await command.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(command.locator("details")).not.toHaveAttribute("open");
  await expect(preview).toBeVisible();
  await page.setViewportSize({ width: 900, height: 640 });
  await expect(failed).toContainText("Error: Cannot find module");
  const nameBox = await command
    .locator("summary")
    .getByText("exec_command", { exact: true })
    .boundingBox();
  const previewBox = await preview.boundingBox();
  expect(
    Math.abs(nameBox!.y + nameBox!.height / 2 - previewBox!.y - previewBox!.height / 2),
  ).toBeLessThan(2);
  await expect
    .poll(() => log.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await page.screenshot({ path: "test-results/tool-previews-narrow.png" });
});

test("transcript search highlights deep input and output matches while keeping tools collapsed", async ({
  page,
}) => {
  const log = page.getByRole("region", { name: "Session conversation" });
  const search = page.getByRole("textbox", { name: "Search the entire transcript…" });
  await search.fill("[deep-match]");
  await expect(log.locator("summary mark")).toHaveText("[deep-match]");
  await expect(log.locator("details[open]")).toHaveCount(0);
  await log.locator("summary").click();
  await expect(log.locator("summary mark")).toHaveCount(0);
  await expect(log.locator("pre").first()).toContainText("[deep-match] end");
  await search.fill("output-needle");
  await expect(log.locator("summary mark")).toHaveText("output-needle");
  await expect(log.locator("summary")).toContainText("Result ·");
  await expect(log.locator("details[open]")).toHaveCount(0);
  await search.fill("Cannot find module");
  await expect(log.locator("summary mark")).toHaveText("Cannot find module");
  await expect(log.locator("summary")).toContainText("Failed");
  await search.fill("pending_tool");
  await expect(log.locator("summary mark")).toHaveText("pending_tool");
  await expect(log.locator("summary")).toContainText("No result recorded");
  await expect(log.locator("details[open]")).toHaveCount(0);
});
