import { expect, test } from "./fixtures";

/**
 * The Google map on a shop page loads only with the visitor's consent (PECR):
 * lib/mapConsent.ts and components/ConsentedMap.tsx. Runs against the bookable
 * E2E fixture shop, which has a fictional address (ensureE2eBookableShop,
 * E2E_BOOKABLE_ADDRESS); its booking confirmation page shows the shop's map
 * from the address alone, so no booking is needed.
 *
 * What only a real browser proves: the hydrated page answers "Show map", our
 * CSP lets the Google frame load (the CSP fixture fails the test otherwise),
 * and the choice survives a reload. The fixture has no generated site, so the
 * page renders without the shop chrome and its cookie notice; the notice's
 * choices are covered by ShopSiteCookieConsent.test.tsx.
 */

const SLUG = "e2e-bookable-shop";

test.describe("Google map consent on a shop page", () => {
  test.setTimeout(60_000);

  test("the map waits for consent, loads on Show map, and stays allowed", async ({ page }) => {
    const response = await page.goto(`/${SLUG}/confirm`, { waitUntil: "networkidle" });
    // The server HTML never carries the Google frame.
    expect(await response!.text()).not.toContain("google.com/maps?q=");

    const mapFrame = page.locator('iframe[src*="google.com/maps"]');
    const showMap = page.getByRole("button", { name: "Show map" });
    await expect(showMap).toBeVisible();
    await expect(page.getByText("This map comes from Google Maps.")).toBeVisible();
    await expect(mapFrame).toHaveCount(0);

    await showMap.click();
    await expect(mapFrame).toHaveCount(1);
    await expect(mapFrame).toHaveAttribute("src", /1%20Fixture%20Lane/);
    await expect(showMap).toHaveCount(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(mapFrame).toHaveCount(1);
  });

  test("an earlier Essential only keeps the map off", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("pp_cookie_consent", JSON.stringify({ essential: true, maps: "declined" }));
      } catch {
        /* ignore */
      }
    });
    await page.goto(`/${SLUG}/confirm`, { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Show map" })).toBeVisible();
    await expect(page.locator('iframe[src*="google.com/maps"]')).toHaveCount(0);
  });
});
