import type { BrowserContext, Page } from "@playwright/test";

function cookieDomain(): string {
  try {
    return new URL(process.env.E2E_BASE_URL || "https://pivotparlor.com").hostname;
  } catch {
    return "localhost";
  }
}

/** SSR-safe E2E: the website forwards these to the Worker (see apps/web/app/lib/e2e-api-headers.ts). */
export async function setE2eCookies(
  context: BrowserContext,
  entries: Array<{ name: string; value: string }>
): Promise<void> {
  const domain = cookieDomain();
  await context.addCookies(
    entries.map((e) => ({ name: e.name, value: e.value, domain, path: "/" }))
  );
}

export async function setE2eCookiesOnPage(
  page: Page,
  entries: Array<{ name: string; value: string }>
): Promise<void> {
  await setE2eCookies(page.context(), entries);
}

/**
 * Pre-acknowledge the cookie notices so their fixed bottom bars never cover
 * buttons the test clicks: the platform's (PlatformCookieBanner,
 * pp_platform_consent) and a shop's (ShopSiteCookieConsent, pp_cookie_consent),
 * which on a shop with an address asks about its Google map until answered.
 * Runs before every document in this page, including the first navigation.
 */
export async function acknowledgePlatformCookieNotice(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      const timestamp = new Date().toISOString();
      localStorage.setItem("pp_platform_consent", JSON.stringify({ decided: true, timestamp }));
      localStorage.setItem(
        "pp_cookie_consent",
        JSON.stringify({ essential: true, maps: "declined", timestamp })
      );
    } catch {
      /* private browsing: the banner shows and the test may need to dismiss it */
    }
  });
}
