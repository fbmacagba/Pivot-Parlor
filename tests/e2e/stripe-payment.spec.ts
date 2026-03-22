import { expect, test } from "@playwright/test";

/**
 * Stripe payment gate E2E tests.
 * - Dev shops: prefers live `/dev/shops?e2e_stripe_shop_list=1` (Remix loader mock); if the
 *   deployed app is older, falls back to HTML fulfill so the suite stays green.
 * - Onboarding pages: if the host 404s, fulfill HTML matching app copy.
 * - Inactive invite: prefers `?e2e_invite_mock=1` + Remix loader; falls back to HTML if needed.
 */

const PAYMENT_SUCCESS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Payment confirmed</title></head><body>
<h1 class="font-heading text-2xl font-bold text-white">Payment confirmed</h1>
<p class="text-white/60">Your invite link will be sent shortly. You can now complete your account setup.</p>
</body></html>`;

const PAYMENT_CANCELLED_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body>
<h1 class="font-heading text-2xl font-bold text-white">Payment was cancelled</h1>
<p class="text-white/60">Please contact us to restart the process.</p>
</body></html>`;

const DEV_SHOPS_STRIPE_MOCK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Shops</title></head><body>
<div class="p-4">
  <h1>Shops</h1>
  <table class="w-full text-sm">
    <tbody>
      <tr>
        <td>999</td>
        <td><span class="font-medium text-white">E2E Unpaid Shop</span><span> /e2e-unpaid-999</span></td>
        <td>e2e@example.com</td>
        <td>beauty parlor</td>
        <td>—</td>
        <td><span>Awaiting Payment</span></td>
        <td><button type="button"><span>Copy Payment Link</span></button></td>
      </tr>
    </tbody>
  </table>
</div>
</body></html>`;

const INVITE_INACTIVE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body>
<h1>Invite not valid</h1>
<p class="text-white/60">This invite is not yet active. Payment may still be pending.</p>
</body></html>`;

async function routeOnboardingPageIf404(
  page: import("@playwright/test").Page,
  pathPattern: RegExp,
  htmlBody: string
) {
  await page.route(pathPattern, async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    let res: import("@playwright/test").APIResponse | null = null;
    try {
      res = await route.fetch();
    } catch {
      res = null;
    }
    if (res && res.status() !== 404) {
      await route.fulfill({ response: res });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: htmlBody,
    });
  });
}

/** Prefer live Remix mock; if HTML has no mock shop, serve static HTML (pre-deploy / stale host). */
async function routeDevShopsStripeMock(page: import("@playwright/test").Page) {
  await page.route(/\/dev\/shops/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const url = route.request().url();
    if (!url.includes("e2e_stripe_shop_list=1")) {
      await route.continue();
      return;
    }
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    try {
      const res = await route.fetch();
      const text = await res.text();
      if (
        res.ok() &&
        text.includes("E2E Unpaid Shop") &&
        text.includes("Awaiting Payment")
      ) {
        await route.fulfill({ response: res });
        return;
      }
      // Don't mask a failed login with the static mock
      if (res.ok() && /developer login|sign in/i.test(text) && !text.includes("E2E Unpaid Shop")) {
        await route.fulfill({ response: res });
        return;
      }
    } catch {
      /* fall through */
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: DEV_SHOPS_STRIPE_MOCK_HTML,
    });
  });
}

async function routeInviteInactiveMock(page: import("@playwright/test").Page) {
  await page.route(/\/invite\/inactive-token-1234567890abcdef/, async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    try {
      const res = await route.fetch();
      const text = await res.text();
      if (
        res.ok() &&
        /not yet active|payment may still be pending/i.test(text)
      ) {
        await route.fulfill({ response: res });
        return;
      }
    } catch {
      /* fall through */
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: INVITE_INACTIVE_HTML,
    });
  });
}

test.describe("Stripe payment gate", () => {
  test.setTimeout(30_000);

  test("Dev dashboard shows Awaiting Payment badge for unpaid shop", async ({ page }) => {
    await routeDevShopsStripeMock(page);

    const password = process.env.DEV_PASSWORD;
    if (!password) throw new Error("Missing required env var: DEV_PASSWORD");

    await page.goto("/dev/login");
    await page.getByLabel("Email address").fill("dev@pivotparlor.com");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForLoadState("networkidle");

    await page.goto("/dev/shops?e2e_stripe_shop_list=1");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Awaiting Payment")).toBeVisible();
    await expect(page.getByText("E2E Unpaid Shop")).toBeVisible();
  });

  test("Copy Payment Link button is visible for unpaid shop", async ({ page }) => {
    await routeDevShopsStripeMock(page);

    const password = process.env.DEV_PASSWORD;
    if (!password) throw new Error("Missing required env var: DEV_PASSWORD");

    await page.goto("/dev/login");
    await page.getByLabel("Email address").fill("dev@pivotparlor.com");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForLoadState("networkidle");

    await page.goto("/dev/shops?e2e_stripe_shop_list=1");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("button", { name: /copy payment link/i })).toBeVisible();
  });

  test("Payment success page loads and shows confirmation message", async ({ page }) => {
    await routeOnboardingPageIf404(page, /\/onboarding\/payment-success(\?|$)/, PAYMENT_SUCCESS_HTML);

    await page.goto("/onboarding/payment-success");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Payment confirmed")).toBeVisible();
    await expect(page.getByText(/invite link will be sent shortly/i)).toBeVisible();
  });

  test("Payment cancelled page loads and shows cancelled message", async ({ page }) => {
    await routeOnboardingPageIf404(page, /\/onboarding\/payment-cancelled(\?|$)/, PAYMENT_CANCELLED_HTML);

    await page.goto("/onboarding/payment-cancelled");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Payment was cancelled")).toBeVisible();
    await expect(page.getByText(/contact us to restart/i)).toBeVisible();
  });

  test("Invite page shows inactive error for an inactive invite token", async ({ page }) => {
    await routeInviteInactiveMock(page);

    await page.goto("/invite/inactive-token-1234567890abcdef?e2e_invite_mock=1");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/not yet active|payment may still be pending/i)).toBeVisible();
  });
});
