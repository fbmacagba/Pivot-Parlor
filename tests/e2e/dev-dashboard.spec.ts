import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { setE2eCookies } from "./e2e-cookies";

/**
 * Developer dashboard (dev.shops) — shops *table* coverage.
 *
 * The rest of the stable subset only exercises the onboard dialog. This spec
 * covers the table surface — rendering + column headers, the status badge, the
 * search/filter, and the delete dialog + delete action — so the dev.shops route
 * can be refactored (T7.7 class-2) with a real runtime net under the parts a
 * prop-threading bug would break.
 *
 * One test, one login, minimal navigations: the dashboard is heavy and staging
 * is a single shared worker, so repeated logins/reloads push past the per-test
 * budget. Kept as a single lifecycle to stay fast and non-flaky.
 *
 * NOT covered here (needs real AI generation — see site-generation.spec.ts): the
 * per-row expanded regen/image panel, which only renders for *active* shops.
 *
 * Requires DEV_PASSWORD (dev@pivotparlor.com). Runs against staging
 * (E2E_FIXTURES), so create takes the invite flow and the slug is `e2e-…`.
 */
test.describe("Dev dashboard — shops table", () => {
  test.beforeEach(async ({ context }) => {
    // Forces the legacy invite flow + marks traffic as E2E for SSR loader fetches.
    await setE2eCookies(context, [{ name: "e2e_legacy_onboard", value: "1" }]);
    // Pre-dismiss the platform cookie banner (a role="dialog" that would otherwise
    // collide with getByRole("dialog") and overlay clickable rows).
    await context.addInitScript(() => {
      try {
        localStorage.setItem(
          "pp_platform_consent",
          JSON.stringify({ analytics: false, marketing: false, timestamp: "2026-01-01T00:00:00.000Z", decided: true })
        );
      } catch {
        /* private mode */
      }
    });
  });

  async function login(page: Page): Promise<void> {
    const password = process.env.DEV_PASSWORD;
    if (!password) throw new Error("Missing required env var: DEV_PASSWORD");
    await page.goto("/login");
    await page.getByLabel("Email address").fill("dev@pivotparlor.com");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    // Wait for the post-login redirect away from /login (cookie set).
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20_000 });
  }

  test("table render → create → status badge → filter → delete", async ({ page }) => {
    test.setTimeout(120_000);
    const uniqueId = Date.now().toString().slice(-6);
    const shopName = `E2E Dashboard ${uniqueId}`;
    const rowFor = (name: string) => page.locator("tr", { hasText: name });

    await login(page);

    // 1. Table chrome renders.
    await page.goto("/dev/shops");
    await expect(page.getByRole("heading", { name: "Shops" })).toBeVisible({ timeout: 15_000 });
    for (const header of ["Name", "Owner", "Status", "Actions"]) {
      await expect(page.getByRole("columnheader", { name: header, exact: true })).toBeVisible();
    }

    // 2. Create a real shop via the onboard dialog.
    await page.getByRole("button", { name: /new shop/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Shop name").fill(shopName);
    await page.getByLabel(/owner email/i).fill(`e2e-dash-${uniqueId}@example.com`);
    await page.getByRole("button", { name: /create shop/i }).click();
    // Success state confirms the create committed before we reload the table.
    await expect(page.getByRole("button", { name: /copy link/i })).toBeVisible({ timeout: 20_000 });

    // 3. New shop shows up as a row with a status badge.
    await page.goto("/dev/shops");
    await expect(rowFor(shopName)).toBeVisible({ timeout: 15_000 });
    await expect(
      rowFor(shopName).getByText(/Awaiting Payment|Pending|Paid|Active|Suspended/).first()
    ).toBeVisible();

    // 4. Search filters the table (and shows the empty-filter state).
    const search = page.getByPlaceholder("Search by name, slug, or owner email…");
    await search.fill(shopName);
    await expect(rowFor(shopName)).toBeVisible();
    await search.fill("zzz-no-such-shop-zzz");
    await expect(page.getByText("No shops match your search.")).toBeVisible();
    await search.fill(""); // clear so the row is interactable again

    // 5. Delete dialog opens and the action removes the row.
    await rowFor(shopName).getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Delete shop" })).toBeVisible();
    await expect(dialog.getByText(shopName)).toBeVisible();
    await dialog.getByRole("button", { name: "Delete shop" }).click();
    // The delete fetcher revalidates the loader on success → dialog closes and the
    // row drops in place. Do NOT navigate here: a goto would abort the in-flight
    // delete request before it commits.
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(rowFor(shopName)).toHaveCount(0, { timeout: 10_000 });
  });
});
