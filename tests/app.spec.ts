import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { emitTo, installIpc } from "./ipc.ts";

const destinations = [
  { path: "/", name: "Overview" },
  { path: "/sessions", name: "Sessions" },
  { path: "/models", name: "Models" },
  { path: "/subscriptions", name: "Subscriptions" },
];

async function expectDestination(page: Page, name: string) {
  await expect(page).toHaveTitle(`${name} · Overwatch`);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(page.getByRole("link", { name, exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
}

async function chooseAppearance(page: Page, name: string) {
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}

async function openAppearanceWithKeyboard(page: Page) {
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  // Bits UI's focus scope applies opening autofocus on the next animation frame.
  // Let it settle before faster-than-paint keyboard navigation or dismissal.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByRole("menuitemradio", { name: "Light", exact: true })).toBeFocused();
}

const initialAppearances = [
  { name: "Light overrides dark OS", saved: "light", os: "dark", expected: "light" },
  { name: "Dark overrides light OS", saved: "dark", os: "light", expected: "dark" },
  { name: "System follows light OS", saved: "system", os: "light", expected: "light" },
  { name: "System follows dark OS", saved: "system", os: "dark", expected: "dark" },
  { name: "invalid mode follows OS", saved: "unknown", os: "dark", expected: "dark" },
  { name: "missing mode follows OS", saved: null, os: "dark", expected: "dark" },
] as const;

for (const initial of initialAppearances) {
  test(`appearance on startup: ${initial.name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: initial.os });
    if (initial.saved !== null) {
      await page.addInitScript(
        (saved) => localStorage.setItem("mode-watcher-mode", saved),
        initial.saved,
      );
    }
    await page.goto("/");
    await expectDestination(page, "Overview");
    await expect(page.locator("html")).toHaveCSS("color-scheme", initial.expected);
    await expect(page.getByRole("main")).toHaveCSS(
      "background-color",
      initial.expected === "dark" ? "rgb(23, 23, 23)" : "rgb(250, 250, 250)",
    );
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    const selected =
      initial.saved === "light" ? "Light" : initial.saved === "dark" ? "Dark" : "System";
    await expect(page.getByRole("menuitemradio", { name: selected, exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "Sessions", exact: true }).click();
    await expectDestination(page, "Sessions");
    await expect(page.locator("html")).toHaveCSS("color-scheme", initial.expected);
    expect(errors).toEqual([]);
  });
}

test("all routes support navigation, direct entry, reload, and browser history without errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) => errors.push(request.url()));
  await page.goto("/");
  for (const destination of destinations) {
    await page.getByRole("link", { name: destination.name, exact: true }).click();
    await expectDestination(page, destination.name);
  }
  const last = destinations.at(-1)?.name ?? "";
  const beforeLast = destinations.at(-2)?.name ?? "";
  await page.goBack();
  await expectDestination(page, beforeLast);
  await page.goForward();
  await expectDestination(page, last);
  for (const destination of destinations) {
    await page.goto(destination.path);
    await expectDestination(page, destination.name);
    await page.reload();
    await expectDestination(page, destination.name);
  }
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('13px "Inter"'))).toBe(true);
  expect(errors).toEqual([]);
});

test("sidebar keeps its width and visible labels through navigation and reload", async ({
  page,
}) => {
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar).toHaveCSS("width", "216px");
  await expect(sidebar.getByText("Overwatch", { exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button")).toHaveCount(1);
  for (const destination of destinations) {
    const link = page.getByRole("link", { name: destination.name, exact: true });
    await expect(link.getByText(destination.name, { exact: true })).toBeVisible();
    await link.click();
    await expectDestination(page, destination.name);
    await expect(sidebar).toHaveCSS("width", "216px");
  }
  await chooseAppearance(page, "Dark");
  await page.reload();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(sidebar).toHaveCSS("width", "216px");
});

test("appearance uses the specified palette and follows system changes only when selected", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const root = page.locator("html");
  const sidebar = page.getByRole("complementary");
  await expect(root).toHaveCSS("color-scheme", "light");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "System", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveCSS("color-scheme", "dark");
  await expect(page.getByRole("main")).toHaveCSS("background-color", "rgb(23, 23, 23)");
  await expect(sidebar).toHaveCSS("background-color", "rgb(20, 20, 20)");
  await expect(root).toHaveCSS("color", "rgb(237, 237, 237)");
  await chooseAppearance(page, "Light");
  await expect(root).toHaveCSS("color-scheme", "light");
  await expect(page.getByRole("main")).toHaveCSS("background-color", "rgb(250, 250, 250)");
  await expect(sidebar).toHaveCSS("background-color", "rgb(242, 242, 242)");
  await expect(root).toHaveCSS("color", "rgb(38, 38, 38)");
  await page.emulateMedia({ colorScheme: "light" });
  await chooseAppearance(page, "Dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveCSS("color-scheme", "dark");
  await page.reload();
  await expect(root).toHaveCSS("color-scheme", "dark");
  await chooseAppearance(page, "System");
  await expect(root).toHaveCSS("color-scheme", "light");
  await page.reload();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveCSS("color-scheme", "dark");
});

test("keyboard access covers skip link, navigation, menu selection and dismissal", async ({
  page,
  browserName,
}) => {
  // macOS WebKit uses Option-Tab to include links regardless of the OS keyboard setting.
  const tabKey = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
  await page.goto("/");
  await expectDestination(page, "Overview");
  await page.keyboard.press(tabKey);
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await page.getByRole("link", { name: "Skip to content" }).focus();
  for (const destination of destinations) {
    await page.keyboard.press(tabKey);
    await expect(page.getByRole("link", { name: destination.name, exact: true })).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expectDestination(page, "Subscriptions");
  await page.getByRole("link", { name: "Subscriptions", exact: true }).focus();
  await page.keyboard.press(tabKey);
  const appearance = page.getByRole("button", { name: "Appearance", exact: true });
  await expect(appearance).toBeFocused();
  await expect(appearance).toHaveCSS("outline-style", "solid");
  await openAppearanceWithKeyboard(page);
  await page.keyboard.press("Home");
  await expect(page.getByRole("menuitemradio", { name: "Light", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: "Dark", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(appearance).toBeFocused();
  await openAppearanceWithKeyboard(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(appearance).toBeFocused();
});

test("appearance survives closing and reopening the browser with the same on-disk profile", async ({
  playwright,
  browserName,
  baseURL,
}, testInfo) => {
  const profile = testInfo.outputPath("persistent-profile");
  const options = { baseURL, colorScheme: "light" as const };
  let context = await playwright[browserName].launchPersistentContext(profile, options);
  try {
    let page = await context.newPage();
    await page.goto("/models");
    await chooseAppearance(page, "Dark");
    await expect(page.getByRole("complementary")).toHaveCSS("width", "216px");
    await context.close();
    context = await playwright[browserName].launchPersistentContext(profile, options);
    page = await context.newPage();
    await page.goto("/sessions");
    await expectDestination(page, "Sessions");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await expect(page.getByRole("complementary")).toHaveCSS("width", "216px");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(page.getByRole("menuitemradio", { name: "Dark", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  } finally {
    await context.close();
  }
});

test("resizing retains usable controls and only page content scrolls", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  for (const size of [
    { width: 640, height: 480 },
    { width: 1200, height: 800 },
    { width: 1600, height: 1000 },
  ]) {
    await page.setViewportSize(size);
    await expect(sidebar).toHaveCSS("width", "216px");
    for (const destination of destinations) {
      await expect(
        page.getByRole("link", { name: destination.name, exact: true }),
      ).toBeInViewport();
    }
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    for (const name of ["Light", "Dark", "System"]) {
      await expect(page.getByRole("menuitemradio", { name, exact: true })).toBeInViewport();
    }
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  // A tall fixture exercises the scroll container. It is prepended rather than
  // appended: a page ending in a control-flow block owns the nodes after its
  // content, and would tear the fixture down with them.
  await page.getByRole("main").evaluate((main) => {
    const fixture = document.createElement("div");
    fixture.style.height = "2400px";
    main.prepend(fixture);
  });
  const before = await sidebar.boundingBox();
  await page.getByRole("main").hover();
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() => page.getByRole("main").evaluate((main) => main.scrollTop))
    .toBeGreaterThan(0);
  expect(await sidebar.boundingBox()).toEqual(before);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  await expectDestination(page, "Sessions");
  await expect.poll(() => page.getByRole("main").evaluate((main) => main.scrollTop)).toBe(0);
});

test("every destination's header stands in the same place", async ({ page }) => {
  await page.goto("/");
  const places: unknown[] = [];
  for (const destination of destinations) {
    await page.getByRole("link", { name: destination.name, exact: true }).click();
    await expectDestination(page, destination.name);
    // A title that fits has no tooltip repeating it.
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveAttribute("title");
    const heading = await page.getByRole("heading", { level: 1 }).boundingBox();
    const header = await page.getByRole("main").locator("header").boundingBox();
    places.push({ x: heading?.x, y: heading?.y, height: header?.height });
  }
  // Moving between destinations moves neither the title nor what follows it.
  for (const place of places) expect(place).toEqual(places[0]);
});

test("invalid saved modes fall back to System", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  for (const value of ["invalid json", '{"appearance":"unknown"}', "null"]) {
    await page.evaluate((saved) => localStorage.setItem("mode-watcher-mode", saved), value);
    await page.reload();
    await expectDestination(page, "Overview");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
    await expect(page.getByRole("complementary")).toHaveCSS("width", "216px");
  }
  expect(errors).toEqual([]);
});

test("unavailable localStorage does not break the shell", async ({ page }) => {
  test.fail(
    true,
    "Mode Watcher 1.1.0 reads localStorage at module initialization without a fallback.",
  );
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
  });
  await page.goto("/");
  await expectDestination(page, "Overview");
  await chooseAppearance(page, "Dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.getByRole("complementary")).toHaveCSS("width", "216px");
});

test("unknown routes show an accessible recovery page inside the shell", async ({ page }) => {
  await page.goto("/missing-page");
  await expect(page.getByRole("heading", { name: "Unable to open this page." })).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.getByRole("link", { name: "Back to Overview" }).click();
  await expectDestination(page, "Overview");
});

test("Back and Forward restore separate visits to the same route", async ({ page }) => {
  await page.goto("/sessions");
  await expectDestination(page, "Sessions");
  const main = page.getByRole("main");
  // Prepended so a page whose content ends in a block does not remove it.
  await main.evaluate((element) => {
    const content = document.createElement("div");
    content.style.height = "2400px";
    element.prepend(content);
  });
  const scrollTo = async (top: number) => {
    await main.evaluate((element, value) => element.scrollTo(0, value), top);
    await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(top);
  };
  await scrollTo(600);
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await expectDestination(page, "Models");
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);
  await scrollTo(300);
  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  await expectDestination(page, "Sessions");
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);
  await scrollTo(900);

  for (const visit of [
    { direction: "back", name: "Models", top: 300 },
    { direction: "back", name: "Sessions", top: 600 },
    { direction: "forward", name: "Models", top: 300 },
    { direction: "forward", name: "Sessions", top: 900 },
  ] as const) {
    if (visit.direction === "back") await page.goBack();
    else await page.goForward();
    await expectDestination(page, visit.name);
    await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(visit.top);
  }
  await page.getByRole("link", { name: "Subscriptions", exact: true }).click();
  await expectDestination(page, "Subscriptions");
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("fragment navigation and history preserve the main scroll container", async ({ page }) => {
  await page.goto("/sessions");
  await expectDestination(page, "Sessions");
  const main = page.getByRole("main");
  await main.evaluate((element) => {
    const content = document.createElement("div");
    content.style.height = "2400px";
    content.innerHTML =
      '<a href="#usage-chart">Jump to chart</a><div style="height:1200px"></div><h2 id="usage-chart">Usage chart</h2>';
    element.prepend(content);
  });
  await page.getByRole("link", { name: "Jump to chart" }).click();
  await expect(page).toHaveURL(/#usage-chart$/);
  await expect(page.getByRole("heading", { name: "Usage chart" })).toBeInViewport();
  const position = await main.evaluate((element) => element.scrollTop);
  expect(position).toBeGreaterThan(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Usage chart" })).toBeInViewport();
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(position);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("new routes honor fragment targets and reset scroll when the target is missing", async ({
  page,
}) => {
  await page.goto("/sessions");
  await expectDestination(page, "Sessions");
  const main = page.getByRole("main");
  await main.evaluate((element) => {
    const content = document.createElement("div");
    content.style.height = "2400px";
    content.innerHTML = '<div style="height:1200px"></div><h2 id="usage-chart">Usage chart</h2>';
    element.prepend(content);
  });
  const models = page.getByRole("link", { name: "Models", exact: true });
  await models.evaluate((link) => link.setAttribute("href", "/models#usage-chart"));
  await models.click();
  await expectDestination(page, "Models");
  await expect(page.getByRole("heading", { name: "Usage chart" })).toBeInViewport();
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const subscriptions = page.getByRole("link", { name: "Subscriptions", exact: true });
  await subscriptions.evaluate((link) => link.setAttribute("href", "/subscriptions#missing"));
  await subscriptions.click();
  await expectDestination(page, "Subscriptions");
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);
});

test("theme initialization and switching work under the desktop script policy", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const config = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  await page.route("**/sessions", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    // Tauri hashes inline scripts from bundled HTML. Apply the same allowances in the browser.
    const hashes = [...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(
      (match) =>
        `'sha256-${createHash("sha256")
          .update(match[1] ?? "")
          .digest("base64")}'`,
    );
    const csp = config.app.security.csp.replace(
      "script-src 'self'",
      `script-src 'self' ${hashes.join(" ")}`,
    );
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": csp },
      body,
    });
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/sessions");
  await expectDestination(page, "Sessions");
  for (const choice of ["Dark", "Light", "System", "Dark"]) {
    await chooseAppearance(page, choice);
    await expect(page.locator("html")).toHaveCSS(
      "color-scheme",
      choice === "Dark" ? "dark" : "light",
    );
    await expect(page.getByRole("main")).toHaveCSS(
      "background-color",
      choice === "Dark" ? "rgb(23, 23, 23)" : "rgb(250, 250, 250)",
    );
  }
  await page.reload();
  await expectDestination(page, "Sessions");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  expect(errors).toEqual([]);
});

test("the menu's Back and Forward move through the window's history", async ({ page }) => {
  await installIpc(page);
  await page.goto("/");
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await expect(page).toHaveTitle("Models · Overwatch");

  await emitTo(page, "main", "command", "back");
  await expect(page).toHaveTitle("Overview · Overwatch");
  await emitTo(page, "main", "command", "forward");
  await expect(page).toHaveTitle("Models · Overwatch");
});

test("the menu's Find searches the sessions from a page that has nothing to find in", async ({
  page,
}) => {
  await installIpc(page);
  await page.goto("/models");
  await expect(page).toHaveTitle("Models · Overwatch");

  await emitTo(page, "main", "command", "find");
  await expect(page).toHaveTitle("Sessions · Overwatch");
  await expect(page.getByLabel("Search sessions")).toBeFocused();
});
