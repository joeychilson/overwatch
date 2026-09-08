import { expect, test } from "@playwright/test";
import { desktop } from "./desktop";

test("overview starts independent reads while usage is still loading", async ({ page }) => {
  await desktop(page, { holdUsage: true });
  await page.goto("/");

  // Keep usage unresolved: session and tool reads must still start, along with
  // all three date scopes. Sequential Suspense hooks would stop at the first one.
  await expect
    .poll(async () => {
      const requests: {
        command: string;
        args: { scope?: { start: number | null; end: number | null }; query?: { limit: number } };
      }[] = JSON.parse((await page.locator("html").getAttribute("data-history-requests")) ?? "[]");
      return {
        usageScopes: new Set(
          requests
            .filter((request) => request.command === "get_usage")
            .map((request) => JSON.stringify(request.args.scope)),
        ).size,
        sessionLimits: [
          ...new Set(
            requests
              .filter((request) => request.command === "get_sessions")
              .map((request) => request.args.query?.limit ?? 0),
          ),
        ].sort((a, b) => a - b),
        tools: requests.some((request) => request.command === "get_tool_stats"),
      };
    })
    .toEqual({ usageScopes: 3, sessionLimits: [1, 5], tools: true });

  await expect(page.getByText("Total tokens", { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-release-usage")));
  await expect(page.getByText("Total tokens", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Sessions", exact: true })).toBeVisible();
});
