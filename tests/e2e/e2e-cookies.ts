import type { BrowserContext, Page } from "@playwright/test";

function cookieDomain(): string {
  try {
    return new URL(process.env.E2E_BASE_URL || "https://pivotparlor.com").hostname;
  } catch {
    return "localhost";
  }
}

/** SSR-safe E2E: Remix forwards these to the Worker (see apps/web/app/lib/e2e-api-headers.ts). */
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
 * Pre-acknowledge the platform cookie notice (PlatformCookieBanner, localStorage key
 * pp_platform_consent) so its fixed bottom bar never covers buttons the test clicks.
 * Runs before every document in this page, including the first navigation.
 */
export async function acknowledgePlatformCookieNotice(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        "pp_platform_consent",
        JSON.stringify({ decided: true, timestamp: new Date().toISOString() })
      );
    } catch {
      /* private browsing: the banner shows and the test may need to dismiss it */
    }
  });
}
