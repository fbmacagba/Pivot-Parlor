import { expect, test } from "@playwright/test";
import { setE2eCookies } from "./e2e-cookies";
import { installShopOnboardingNetworkMocks } from "./shop-onboarding-routes";

/**
 * Shop onboarding E2E suite.
 *
 * Requires env vars:
 *   DEV_PASSWORD — password for dev@pivotparlor.com
 *
 * Tests are sequential (test.describe.serial) because each depends on the
 * session cookie established by the first test.
 */
test.describe.serial("Shop onboarding", () => {
  // Shared state between the three tests in this suite.
  let inviteUrl = "";

  test.beforeEach(async ({ context, page }) => {
    await setE2eCookies(context, [{ name: "e2e_legacy_onboard", value: "1" }]);
    await installShopOnboardingNetworkMocks(page);
  });

  // ── 1. Dev can open the New Shop modal ──────────────────────────────────────
  test("Dev can open New Shop modal", async ({ page }) => {
    const password = process.env.DEV_PASSWORD;
    if (!password) throw new Error("Missing required env var: DEV_PASSWORD");

    // Log in first for this page context
    await page.goto("/login");
    await page.getByLabel("Email address").fill("dev@pivotparlor.com");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForLoadState("networkidle");

    await page.goto("/dev/shops");
    await page.waitForLoadState("networkidle");

    // The button text changed from "Onboard new shop" to "New Shop"
    const newShopBtn = page.getByRole("button", { name: /new shop/i });
    await expect(newShopBtn).toBeVisible();
    await newShopBtn.click();

    // Dialog should appear
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Onboard new shop")).toBeVisible();

    // Form fields should be present
    await expect(page.getByLabel("Shop name")).toBeVisible();
    await expect(page.getByLabel(/owner email/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /create shop/i })).toBeVisible();
  });

  // ── 3. Form submits and returns an invite link ───────────────────────────────
  test("Form submits and returns an invite link", async ({ page }) => {
    const password = process.env.DEV_PASSWORD;
    if (!password) throw new Error("Missing required env var: DEV_PASSWORD");

    // Use a unique timestamp-based name to avoid slug collisions on re-runs
    const uniqueId = Date.now().toString().slice(-6);
    const shopName = `E2E Test Shop ${uniqueId}`;
    const ownerEmail = `e2e-owner-${uniqueId}@example.com`;

    // Log in
    await page.goto("/login");
    await page.getByLabel("Email address").fill("dev@pivotparlor.com");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForLoadState("networkidle");

    await page.goto("/dev/shops");
    await page.waitForLoadState("networkidle");

    // Open modal
    await page.getByRole("button", { name: /new shop/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Fill form
    await page.getByLabel("Shop name").fill(shopName);
    await page.getByLabel(/owner email/i).fill(ownerEmail);

    // Submit
    await page.getByRole("button", { name: /create shop/i }).click();
    await page.waitForLoadState("networkidle");

    // Success state: invite link should be visible
    const inviteLinkEl = page.locator("text=pivotparlor.com/invite/");
    await expect(inviteLinkEl).toBeVisible({ timeout: 10_000 });

    // Extract the invite URL for the next test
    const text = await inviteLinkEl.textContent();
    expect(text).toMatch(/pivotparlor\.com\/invite\/[a-f0-9]{64}/);

    // Extract just the path portion for navigation
    const match = text?.match(/pivotparlor\.com(\/invite\/[a-f0-9]{64})/);
    if (match) inviteUrl = match[1];

    // Copy button should also be present
    await expect(page.getByRole("button", { name: /copy link/i })).toBeVisible();
  });

  // ── 4. Invite link loads the set-password form ───────────────────────────────
  test("Invite link loads the set-password form", async ({ page }) => {
    expect(inviteUrl, "invite URL must be captured from previous test").toMatch(
      /^\/invite\/[a-f0-9]{64}$/
    );

    await page.goto(inviteUrl);
    await page.waitForLoadState("networkidle");

    // The invite acceptance page should render
    await expect(page.getByText(/you're invited/i)).toBeVisible();
    await expect(page.getByLabel("Full name")).toBeVisible();
    await expect(page.getByLabel(/^Password$/)).toBeVisible();
    await expect(page.getByLabel(/confirm password/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /activate account/i })
    ).toBeVisible();
  });

  // ── 5. Full invite acceptance — submit form, redirect to template select ────
  test("Full invite acceptance redirects to template selection", async ({ page }) => {
    expect(inviteUrl, "invite URL must be captured from previous test").toMatch(
      /^\/invite\/[a-f0-9]{64}$/
    );

    await page.goto(inviteUrl);
    await page.waitForLoadState("networkidle");

    await page.getByLabel("Full name").fill("E2E Admin User");
    await page.getByLabel(/^Password$/).fill("SecurePass123!");
    await page.getByLabel(/confirm password/i).fill("SecurePass123!");

    await page.getByRole("button", { name: /activate account/i }).click();
    await page.waitForLoadState("networkidle");

    // Should redirect to template selection (owner flow) or admin (if already has site)
    await expect(page).toHaveURL(/\/(admin|setup\/template-select)(\/|$)/);
  });
});
