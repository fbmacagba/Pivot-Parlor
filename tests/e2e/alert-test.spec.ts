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
 * Requires DEV_PASSWORD (dev@pivotparlor.com).
 */

const PATH = "/api/dev/alert-test";

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
