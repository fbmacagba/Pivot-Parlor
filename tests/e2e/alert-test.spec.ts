import type { Page } from "@playwright/test";
import { acknowledgePlatformCookieNotice } from "./e2e-cookies";
import { expect, test } from "./fixtures";

/**
 * The developer dashboard's "Send a test alert", on staging.
 *
 * A developer's press raises one AlertTestError. The website reports it over
 * its WEB_ERRORS binding to the STAGING API, whose Issues are off, so nothing
 * is emailed. This spec proves the website side: only a developer gets the
 * deliberate 500, and the page says so. That the report arrived is read from
 * the staging API's Workers Logs, the event
 * `[web] AlertTestError in action POST /api/dev/alert-test`
 * (docs/runbooks/production-alerting.md, Website server errors).
 *
 * And its "Send a test browser alert": one BrowserAlertTestError thrown in the
 * developer's own browser, which the page posts to the website's
 * /client-errors and the website passes to the staging API. That the report
 * arrived is read from the staging API's Workers Logs, the event
 * `[browser] BrowserAlertTestError in script on routes/dev._index`
 * (docs/runbooks/production-alerting.md, Browser errors). The website always
 * answers 204, so the 204 alone proves only that the page sent it.
 *
 * Requires DEV_PASSWORD (dev@pivotparlor.com).
 */

const PATH = "/api/dev/alert-test";
const CLIENT_ERRORS_PATH = "/client-errors";
const BROWSER_ALERT_TEST_MESSAGE = "Test browser error raised. The alert email should reach you within a few minutes.";
// isbot flags Playwright's own headless Chromium ("HeadlessChrome/145",
// measured 2026-11-12), and the website drops a bot's report without a word.
// The browser alert is pressed as a desktop Chrome.
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

async function login(page: Page): Promise<void> {
  const password = process.env.DEV_PASSWORD;
  if (!password) throw new Error("Missing required env var: DEV_PASSWORD");
  await page.goto("/login");
  await page.getByLabel("Email address").fill("dev@pivotparlor.com");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20_000 });
}

test.describe("Alert check: staging", () => {
  test("a developer's test alert raises the labelled error; nobody else's does", async ({ page }) => {
    test.setTimeout(90_000);
    await acknowledgePlatformCookieNotice(page);

    // Control: signed out, the route turns the request away instead of throwing.
    const anonymous = await page.request.post(PATH, { maxRedirects: 0 });
    expect(anonymous.status()).toBe(302);
    expect(anonymous.headers()["location"] ?? "").toMatch(/^\/login/);

    await login(page);
    await page.goto("/dev", { waitUntil: "networkidle" });
    const button = page.getByRole("button", { name: "Send a test alert" });
    const status = page.getByRole("status").filter({ hasText: /test error/i });

    // Until the page has hydrated a press does nothing, so press until the
    // page answers, and keep the response it answered with.
    let answered: number | null = null;
    await expect(async () => {
      const response = page.waitForResponse(
        (r) => new URL(r.url()).pathname === PATH && r.request().method() === "POST",
        { timeout: 5_000 },
      );
      await button.click();
      answered = (await response).status();
    }).toPass({ timeout: 30_000 });

    expect(answered).toBe(500);
    await expect(status).toHaveText("Test error raised. The alert email should reach you within a few minutes.");
    // Where to look in the staging API's logs.
    console.log(`[alert-test] pressed at ${new Date().toISOString()}`);
  });
});

test.describe("Browser alert check: staging", () => {
  test.use({ userAgent: DESKTOP_CHROME_UA });

  test("a developer's test browser alert is posted as a report about our own code", async ({ page }) => {
    test.setTimeout(90_000);
    await acknowledgePlatformCookieNotice(page);
    await login(page);
    await page.goto("/dev", { waitUntil: "networkidle" });
    const button = page.getByRole("button", { name: "Send a test browser alert" });
    const status = page.getByRole("status").filter({ hasText: /test browser error/i });

    // Registered before any press: the page reports one error once, so a
    // second press after the first report sends nothing more.
    const posted = page.waitForResponse(
      (r) => new URL(r.url()).pathname === CLIENT_ERRORS_PATH && r.request().method() === "POST",
      { timeout: 45_000 },
    );
    // Until the page has hydrated a press does nothing, so press until it says so.
    await expect(async () => {
      await button.click();
      await expect(status).toHaveText(BROWSER_ALERT_TEST_MESSAGE, { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    const response = await posted;
    const report = response.request().postDataJSON() as Record<string, unknown>;
    // Answered by the website's middleware, not Remix (which has no such route).
    expect(response.status()).toBe(204);
    expect(report).toMatchObject({
      kind: "script",
      route: "routes/dev._index",
      name: "BrowserAlertTestError",
      message: "Deliberate test error from the developer dashboard, in the browser",
    });
    const frames = report.frames as string[];
    expect(frames.some((f) => /\/assets\/[^\s()]+:\d+:\d+/.test(f))).toBe(true);
    // Our own script paths only, without an origin: no page URL, no other site.
    expect(frames.join(" ")).not.toMatch(/https?:\/\//);
    console.log(`[browser-alert-test] pressed at ${new Date().toISOString()}`);
  });
});
