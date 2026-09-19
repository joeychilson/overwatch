/**
 * The Subscriptions page. A limit that could not be read again, or whose window
 * has ended since, must read as such rather than as current.
 */
import { expect, test } from "@playwright/test";
import { account, installIpc, settle, status } from "./ipc.ts";

test.beforeEach(async ({ page }) => {
  await installIpc(page);
});

/** A limit covering all usage, resetting far enough ahead that no run sees it end. */
function limit(usedPercent: number, scope: string | null = null) {
  return { name: "Weekly", scope, usedPercent, resetsAt: 4_102_444_800_000, runsOutAt: null };
}

test("an account shows what is left of each limit, who holds it, and when it was read", async ({
  page,
}) => {
  await page.goto("/subscriptions");
  await settle(page, "get_status", status({ accounts: [account()] }));

  const codex = page.getByRole("region", { name: "Codex joey@example.com" });
  await expect(codex.getByRole("heading", { name: "Codex" })).toBeVisible();
  await expect(codex.getByText("pro")).toBeVisible();
  await expect(codex.getByText("58% left")).toBeVisible();
  await expect(codex.getByText("44% left")).toBeVisible();
  // The reading's age is stated, because a stale percentage shown as live
  // would be worse than showing none.
  await expect(codex.getByText(/^Updated /)).toHaveAttribute(
    "title",
    /^Signed in with Codex and Pi/,
  );
});

test("two accounts of one subscription are each shown", async ({ page }) => {
  await page.goto("/subscriptions");
  const work = account({ id: "codex:workspace-2", label: "work@example.com", via: ["OpenCode"] });
  await settle(page, "get_status", status({ accounts: [account(), work] }));

  await expect(page.getByRole("region", { name: "Codex joey@example.com" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Codex work@example.com" })).toBeVisible();
});

test("a failed refresh keeps the last limits and says how to fix it", async ({ page }) => {
  await page.goto("/subscriptions");
  await settle(page, "get_status", status({ accounts: [account({ problem: "sign_in" })] }));

  await expect(page.getByText("Open Codex or Pi to renew the sign-in.")).toBeVisible();
  await expect(page.getByText("58% left")).toBeVisible();
});

test("a used-up limit says when it is back rather than showing a percentage", async ({ page }) => {
  await page.goto("/subscriptions");
  const spent = { ...limit(100), resetsAt: Date.now() + 72 * 60_000 };
  await settle(page, "get_status", status({ accounts: [account({ limits: [spent] })] }));

  await expect(page.getByText("Limit reached")).toBeVisible();
  await expect(page.getByText(/^Back in /)).toBeVisible();
  await expect(page.getByText("0% left")).toHaveCount(0);
});

test("a limit whose window has ended reads as full again, not as its old figure", async ({
  page,
}) => {
  await page.goto("/subscriptions");
  const ended = { ...limit(85), resetsAt: 1_789_000_000_000 };
  await settle(page, "get_status", status({ accounts: [account({ limits: [ended] })] }));

  await expect(page.getByText("Full again")).toBeVisible();
  await expect(page.getByText("15% left")).toHaveCount(0);
});

test("the account nearest a limit comes first, unless only one model's limit is near", async ({
  page,
}) => {
  await page.goto("/subscriptions");
  const accounts = [
    account({ id: "claude:", provider: "claude", label: null, limits: [limit(20)] }),
    // Spark is used up, but only Spark: the account can still be worked in.
    account({ id: "codex:a", limits: [limit(10), limit(100, "GPT-5.3-Codex-Spark")] }),
    account({ id: "grok:b", provider: "grok", label: null, limits: [limit(95)] }),
  ];
  await settle(page, "get_status", status({ accounts }));

  const cards = page.getByRole("main").getByRole("heading", { level: 2 });
  await expect(cards).toHaveText(["Grok", "Claude", "Codex"]);
});

test("a limit on pace to run out before it resets says when", async ({ page }) => {
  await page.goto("/subscriptions");
  const pressed = { ...limit(60), runsOutAt: Date.now() + 45 * 60_000 };
  await settle(page, "get_status", status({ accounts: [account({ limits: [pressed] })] }));

  await expect(page.getByText(/^Runs out in /)).toBeVisible();
});

test("no subscriptions explains where limits come from", async ({ page }) => {
  await page.goto("/subscriptions");
  await settle(page, "get_status", status());

  await expect(page.getByText("No subscriptions found")).toBeVisible();
  await expect(page.getByText(/^Overwatch reads/)).toBeVisible();
});
