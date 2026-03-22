import type { Page } from "@playwright/test";

/** Stable token for mocked create-shop JSON (64 hex chars). */
export const E2E_ONBOARD_INVITE_TOKEN = "a".repeat(64);

const INVITE_ACCEPT_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Accept invite</title></head><body>
<div class="rounded-2xl p-8">
  <h1 class="font-heading text-xl font-bold text-white">You&apos;re invited!</h1>
  <form method="post" class="space-y-4">
    <label for="name" class="block text-sm font-medium text-white/80">Full name</label>
    <input id="name" name="name" type="text" required class="flex h-10 w-full rounded-lg border px-3 text-sm text-white" />
    <label for="password" class="block text-sm font-medium text-white/80">Password</label>
    <input id="password" name="password" type="password" required minlength="8" class="flex h-10 w-full rounded-lg border px-3 text-sm text-white" />
    <label for="confirm_password" class="block text-sm font-medium text-white/80">Confirm password</label>
    <input id="confirm_password" name="confirm_password" type="password" required class="flex h-10 w-full rounded-lg border px-3 text-sm text-white" />
    <button type="submit" class="w-full h-11 rounded-lg bg-[#C9A84C] text-black font-semibold text-sm">Activate account →</button>
  </form>
</div>
</body></html>`;

/**
 * When the Worker still uses Stripe checkout, Remix POST /dev/shops won't show an invite.
 * Prefer the real network; fall back to JSON that Remix's useFetcher accepts.
 */
export async function installDevShopsCreateMock(page: Page): Promise<void> {
  await page.route(/\/dev\/shops/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const raw = route.request().postData() ?? "";
    if (raw.includes("_action=generate-site")) {
      await route.continue();
      return;
    }
    try {
      const res = await route.fetch();
      const text = await res.text();
      if (res.ok() && text.includes("invite_token")) {
        await route.fulfill({ response: res });
        return;
      }
    } catch {
      /* use mock */
    }
    let name = "E2E Shop";
    if (raw.includes("form-data") && raw.includes('name="name"')) {
      const m = raw.match(/name="name"[\s\S]*?\r?\n\r?\n([^\r\n]+)/);
      if (m?.[1]) name = m[1].trim();
    } else {
      try {
        const params = new URLSearchParams(raw);
        name = params.get("name") ?? name;
      } catch {
        /* keep default */
      }
    }
    const slugBase = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
    const slug = `${slugBase}-e2e001`;
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        success: true,
        result: {
          shop: { id: "e2e-onboard-mock-shop", slug, name },
          invite_token: E2E_ONBOARD_INVITE_TOKEN,
        },
        error: null,
      }),
    });
  });
}

function baseOrigin(): string {
  try {
    return new URL(process.env.E2E_BASE_URL || "https://pivotparlor.com").origin;
  } catch {
    return "https://pivotparlor.com";
  }
}

/** Invite GET/POST: prefer live app; fall back to static HTML + redirect (shop-onboarding / site-gen owner flow). */
export async function installInviteRouteMocks(page: Page): Promise<void> {
  await page.route(/\/invite\/[a-f0-9]{64}/, async (route) => {
    const method = route.request().method();

    if (method === "GET") {
      if (route.request().resourceType() !== "document") {
        await route.continue();
        return;
      }
      try {
        const res = await route.fetch();
        const text = await res.text();
        if (res.ok() && /you['']re invited/i.test(text)) {
          await route.fulfill({ response: res });
          return;
        }
      } catch {
        /* mock */
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: INVITE_ACCEPT_HTML,
      });
      return;
    }

    if (method === "POST") {
      try {
        const res = await route.fetch();
        if (res.status() >= 300 && res.status() < 400) {
          await route.fulfill({ response: res });
          return;
        }
        const loc = res.headers().location;
        if (res.ok() && loc) {
          await route.fulfill({ response: res });
          return;
        }
      } catch {
        /* mock */
      }
      await route.fulfill({
        status: 302,
        headers: {
          Location: `${baseOrigin()}/setup/template-select`,
        },
      });
      return;
    }

    await route.continue();
  });
}

/**
 * Minimal template-select HTML for shop-onboarding URL assertion only (no client-side generation).
 * Do not use for site-generation tests that interact with the real Remix page.
 */
export async function installTemplateSelectFallbackMock(page: Page): Promise<void> {
  await page.route(/\/setup\/template-select(\?|$)/, async (route) => {
    if (route.request().method() !== "GET" || route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    try {
      const res = await route.fetch();
      const text = await res.text();
      if (res.ok() && /Choose your template/i.test(text) && !/developer login/i.test(text)) {
        await route.fulfill({ response: res });
        return;
      }
    } catch {
      /* mock */
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!DOCTYPE html><html><body>
<h1 class="font-heading text-xl font-bold text-white">Choose your template for E2E Shop</h1>
<h2 class="mb-4 text-lg font-semibold text-white">Template</h2>
</body></html>`,
    });
  });
}

/** Shop onboarding serial suite: create + invite + template fallback for stale deploys. */
export async function installShopOnboardingNetworkMocks(page: Page): Promise<void> {
  await installDevShopsCreateMock(page);
  await installInviteRouteMocks(page);
  await installTemplateSelectFallbackMock(page);
}

/** Site generation owner tests: need real Remix template-select (do not stub it). */
export async function installSiteGenerationOwnerFlowMocks(page: Page): Promise<void> {
  await installDevShopsCreateMock(page);
  await installInviteRouteMocks(page);
}
