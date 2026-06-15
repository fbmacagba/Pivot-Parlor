import { expect, test } from "@playwright/test";

/**
 * Public customer booking flow, end-to-end against the bookable E2E fixture shop
 * (active shop + service + staff + 7-day schedule, lazily provisioned by the
 * worker under E2E_FIXTURES — see ensureE2eBookableShop). Guards the bugs that
 * made the wizard non-functional: shop_slug->shop_id, slot rendering, and the
 * client-side slot fetch. Requires E2E_FIXTURES=true on the target API.
 */

const SLUG = "e2e-bookable-shop";
// Far-future date: the fixture seeds 09:00-17:00 every weekday, and the fixture
// is wiped + recreated fresh each gate run, so slots are available.
const FUTURE_DATE = "2099-06-15";

test.describe("public booking flow", () => {
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

  test("customer completes a booking end-to-end", async ({ page }) => {
    await page.goto(`/${SLUG}/book`, { waitUntil: "networkidle" });

    // Step 1 — service
    await page.getByRole("button", { name: /E2E Haircut/i }).click();

    // Step 2 — staff (let the backend resolve "any available")
    await page.getByRole("button", { name: /any available/i }).click();

    // Step 3 — date, then a slot (loaded client-side via the fetcher)
    await page.getByLabel("Date").fill(FUTURE_DATE);
    const slotButtons = page.getByRole("button", { name: /^\d{1,2}:\d{2}$/ });
    await expect(slotButtons.first()).toBeVisible({ timeout: 20_000 });
    // Pick a random available slot to stay robust under retries.
    const count = await slotButtons.count();
    await slotButtons.nth(Math.floor(Math.random() * count)).click();
    await page.getByRole("button", { name: /next/i }).click();

    // Step 4 — details
    await page.getByLabel("Full name").fill("E2E Customer");
    await page.getByLabel("Email address").fill("e2e-customer@example.com");
    await page.getByRole("button", { name: /next/i }).click();

    // Step 5 — review & confirm
    await page.getByRole("button", { name: /confirm booking/i }).click();

    // Successful booking redirects to the confirmation page
    await expect(page).toHaveURL(new RegExp(`/${SLUG}/confirm`), { timeout: 20_000 });
  });
});
