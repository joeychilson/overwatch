import { expect, test } from "@playwright/test";
import { desktop } from "./desktop";

test("model names and usage load compact prices until pricing catalog opens", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  await expect(page.getByText("Total tokens", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByRole("table", { name: "Model usage" })).toBeVisible();
  expect(
    JSON.parse((await page.locator("html").getAttribute("data-catalog-requests")) ?? "[]"),
  ).toEqual(["compact"]);
  await page.getByRole("button", { name: "Pricing catalog", exact: true }).click();
  await expect(page.getByRole("button", { name: "GPT-6 Astra", exact: true })).toBeVisible();
  expect(
    JSON.parse((await page.locator("html").getAttribute("data-catalog-requests")) ?? "[]"),
  ).toEqual(["compact", "stored"]);
  await page.getByRole("button", { name: "Refresh catalog", exact: true }).click();
  await expect
    .poll(async () =>
      JSON.parse((await page.locator("html").getAttribute("data-catalog-requests")) ?? "[]"),
    )
    .toEqual(["compact", "stored", "refresh", "compact"]);
});
