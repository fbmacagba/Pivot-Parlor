import { expect, test } from "@playwright/test";

/**
 * Public walk-in queue, against the bookable E2E fixture shop (lazily
 * provisioned by the worker under E2E_FIXTURES when the shop page loads; see
 * ensureE2eBookableShop).
 *
 * Guards the bug where the walk-in page called the production API host straight
 * from the browser, so a staging or preview site joined the PRODUCTION queue
 * (and showed production's answer). Both calls must now go to the page's own
 * site, whose server forwards them to that environment's API.
 */

const SLUG = "e2e-bookable-shop";

test.describe("public walk-in queue", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    // Suppress the cookie-consent banner so it can't intercept clicks.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("pp_cookie_consent", JSON.stringify({ essential: true }));
        localStorage.setItem("pp_platform_consent", JSON.stringify({ decided: true }));
      } catch {
        /* ignore */
      }
    });
  });

  test("customer joins the queue through the site's own API", async ({ page }) => {
    await page.goto(`/${SLUG}/walkin`, { waitUntil: "networkidle" });
    const siteOrigin = new URL(page.url()).origin;

    const joined = page.waitForResponse(
      (r) => r.url().includes(`/api/walkin/${SLUG}/join`) && r.request().method() === "POST"
    );
    // The page polls its status as soon as it has joined.
    const polled = page.waitForResponse((r) => r.url().includes(`/api/walkin/${SLUG}/status/`));

    await page.getByPlaceholder("Jane Smith").fill("E2E Walk-in");
    await page.getByRole("button", { name: /join the queue/i }).click();

    const join = await joined;
    expect(new URL(join.url()).origin, "join must go to the site itself, not a hard-coded API host").toBe(siteOrigin);
    expect(join.status(), `join failed: ${await join.text()}`).toBe(201);

    await expect(page.getByText("Your queue position")).toBeVisible();

    const status = await polled;
    expect(new URL(status.url()).origin, "the status poll must go to the site itself").toBe(siteOrigin);
    expect(status.ok(), `status poll failed: ${status.status()}`).toBeTruthy();
    const body = (await status.json()) as { success?: boolean; data?: { name?: string; status?: string } };
    expect(body.success).toBe(true);
    expect(body.data?.name).toBe("E2E Walk-in");
    expect(body.data?.status).toBe("waiting");
  });
});
