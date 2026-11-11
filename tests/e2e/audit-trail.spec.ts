import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { acknowledgePlatformCookieNotice } from "./e2e-cookies";

/**
 * Staging E2E for the audit trail (Plan 1): pausing/activating a site is
 * recorded, sealed and archived; the erasure-request dialog's Cancel path
 * never submits a request.
 *
 * Login: copied verbatim from tests/e2e/dev-dashboard.spec.ts's local,
 * non-exported `login(page)` helper — the fullest of the several inline
 * login sequences repeated across this folder (dev-login.spec.ts,
 * dev-shop-delete-repro.spec.ts and shop-onboarding.spec.ts all repeat a
 * shorter version of the same three steps). It is not exported anywhere, so
 * it cannot be imported without editing that file (out of scope for this
 * task) — copied here instead of inventing a new login sequence.
 *
 * Test shop: `e2e-bookable-shop`, the ONLY developer-authenticated E2E
 * fixture shop that exists today (`ensureE2eBookableShop`,
 * apps/worker/src/db/queries.ts, exported as `E2E_BOOKABLE_SLUG`). It is
 * lazily created by the first request that reads it — the same navigation
 * booking.spec.ts uses (`page.goto(`/${SLUG}/book`)`) — and wiped + recreated
 * fresh by scripts/cleanup-e2e-shops.mjs (e2e-* prefix) at the start of
 * every gate run. Never pause or activate any other shop here.
 *
 * Deviation from "through the dashboard UI" (announced): this fixture has
 * no `shop_sites` row (it exists to make the PUBLIC booking flow bookable,
 * not to have a live website), so the Shops page's Pause/Resume buttons —
 * which only render once a shop's website_status is already "live" or
 * "paused" (apps/web/app/routes/dev.shops._index.tsx) — never appear for
 * it. `changeWebsiteStatus` (apps/worker/src/routes/shops.ts) still writes
 * a real audit entry even with no site row (a 0-row UPDATE, `ok: true`,
 * `details.no_site_row`), and resolves its `:shopId` route param by slug
 * before falling back to id, so this test POSTs straight to the same routes
 * those buttons submit to (`POST /api/shops/e2e-bookable-shop/{pause,activate}`)
 * through this same authenticated browser session, rather than driving
 * real/mocked AI site generation (expensive, and already gated behind
 * `E2E_SITE_GENERATION=1` in site-generation.spec.ts) just to get a
 * `shop_sites` row so a button renders.
 */

const E2E_SHOP_SLUG = "e2e-bookable-shop";

// What Cloudflare puts in CF-Connecting-IP on any cross-zone Worker
// subrequest, whoever the visitor was (developers.cloudflare.com/fundamentals/
// reference/http-headers/#cf-connecting-ip-in-worker-subrequests).
const CLOUDFLARE_CROSS_ZONE_IP = "2a06:98c0:3600::103";

async function login(page: Page): Promise<void> {
  const password = process.env.DEV_PASSWORD;
  if (!password) throw new Error("Missing required env var: DEV_PASSWORD");
  await page.goto("/login");
  await page.getByLabel("Email address").fill("dev@pivotparlor.com");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20_000 });
}

test.describe("Audit trail — staging", () => {
  test("pausing a site is recorded, sealed and archived", async ({ page }) => {
    test.setTimeout(200_000);
    await acknowledgePlatformCookieNotice(page);
    await login(page);

    // Lazily provisions the fixture shop if this gate run hasn't touched it
    // yet (ensureE2eBookableShop runs on GET /api/shops/:shopId).
    await page.goto(`/${E2E_SHOP_SLUG}/book`, { waitUntil: "networkidle" });

    const pauseRes = await page.request.post(`/api/shops/${E2E_SHOP_SLUG}/pause`);
    expect(pauseRes.ok(), `pause failed: ${pauseRes.status()} ${await pauseRes.text()}`).toBeTruthy();

    // /activate always runs in `finally`, even if an assertion below
    // throws (e.g. the archived-wait times out): this fixture has no
    // shop_sites row (see the header comment), so a failed pause here
    // isn't leaving a real site "stuck paused" -- the point is to still
    // emit the matching site.activate audit entry and leave the shared
    // fixture shop in a clean, symmetrical state for the next gate run
    // (cleanup-e2e-shops.mjs recreates e2e-* shops fresh each run anyway,
    // but that's a separate safety net, not a reason to skip this).
    try {
      // Own-entry `.first()` scoping below relies on e2e.yml running this
      // spec serialized: the "e2e-staging" concurrency group
      // (cancel-in-progress: false) means only one staging E2E run exists
      // at a time, and that run's own `--workers=1` means its specs (and
      // this file's own tests) never execute concurrently with each other
      // either, so nothing else can be writing a competing site.pause
      // entry while this test runs.
      //
      // Audit entries are append-only and survive cleanup-e2e-shops (it
      // only deletes shops, never audit_log rows), and this same fixture
      // shop gets paused/activated on every gate run, so every earlier
      // run's "Site paused" entries are still here on this filtered view,
      // already Archived. A page-wide `getByText("Archived").first()`
      // would therefore match one of THOSE straight away, regardless of
      // whether this run's own entry ever seals -- so the Archived check
      // below is scoped to the SAME <li> as this run's own "Site paused"
      // entry, not to the page.
      await page.goto("/dev/activity?action=site.");
      // Locators are live queries, not snapshots, so this same reference
      // is safe to re-check across the reloads below.
      const pauseEntry = page.locator("ol > li").filter({ hasText: "Site paused" }).first();
      await expect(pauseEntry).toBeVisible();

      // Sealing runs every minute on staging.
      await expect(async () => {
        await page.reload();
        await expect(pauseEntry.getByText("Archived", { exact: true })).toBeVisible();
      }).toPass({ timeout: 150_000, intervals: [15_000] });

      // A check reads up to MANUAL_VERIFY_ARCHIVE_OBJECTS archive objects
      // (apps/worker/src/routes/audit.ts), several at once; give it longer
      // than the default 10s. Either answer says "intact" (a check that hit
      // its read limit says "intact so far").
      await page.getByRole("button", { name: "Check now" }).click();
      await expect(page.getByRole("status")).toContainText("intact", { timeout: 30_000 });

      // The pause above went through the website, which reaches the API over
      // a service binding carrying the visitor's IP (apps/web/app/lib/
      // apiTransport.ts). Over the public internet every visitor reached the
      // API as Cloudflare's one cross-zone address, so all of them shared every
      // per-IP rate limit (bookings, sign-in, sign-up). Guard that it stays fixed.
      await pauseEntry.locator("summary").click();
      const ipLine = pauseEntry.getByText(/^IP: /);
      await expect(ipLine).toBeVisible();
      const ip = ((await ipLine.textContent()) ?? "").replace(/^IP:\s*/, "").trim();
      expect(ip, "the entry recorded no usable IP").toMatch(/^[0-9a-f.:]{3,}$/i);
      expect(ip, "the API saw Cloudflare's shared cross-zone address, not the visitor's IP").not.toBe(
        CLOUDFLARE_CROSS_ZONE_IP
      );
    } finally {
      // Nothing in this block may throw, or it would replace (mask) a
      // pending failure from the try block above -- that's plain JS
      // finally semantics, not a Playwright quirk. Both the request itself
      // (which could reject, e.g. on a network error) and the outcome
      // check use expect.soft, which records a failure without throwing:
      // Playwright still fails the test once it finishes running if any
      // soft assertion failed (confirmed against this repo's installed
      // playwright/types/test.d.ts: `Expect.soft` returns normal matchers,
      // and Playwright's own docs describe soft assertions as continuing
      // the test and reporting all failures once it has finished).
      try {
        const activateRes = await page.request.post(`/api/shops/${E2E_SHOP_SLUG}/activate`);
        expect.soft(activateRes.ok(), `activate failed: ${activateRes.status()} ${await activateRes.text()}`).toBeTruthy();
      } catch (err) {
        expect.soft(false, `activate request threw: ${err instanceof Error ? err.message : String(err)}`).toBeTruthy();
      }
    }
  });

  test("erasure confirmation dialog: Cancel does not submit", async ({ page }) => {
    await acknowledgePlatformCookieNotice(page);
    await login(page);

    // Opening Activity writes its own "Activity viewed" entry (audit.view)
    // attributed to the signed-in developer BEFORE the page's own list
    // query runs, so it is one of the first rows on this very load — a
    // reliable, always-present listed person to open the erasure dialog
    // for, without touching any shop or customer data.
    await page.goto("/dev/activity");

    const entries = page.locator("ol > li");
    const count = await entries.count();
    let eraseButton: Locator | null = null;
    for (let i = 0; i < count; i++) {
      const entry = entries.nth(i);
      await entry.locator("summary").click();
      const btn = entry.getByRole("button", { name: "Record erasure request" });
      if ((await btn.count()) > 0) {
        eraseButton = btn;
        break;
      }
    }
    expect(eraseButton, "no entry with a person to erase was found on the Activity page").not.toBeNull();
    await eraseButton!.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Record erasure request" })).toBeVisible();

    // Only start listening once the dialog is open: from here on, Cancel
    // must cause absolutely no POST request of any kind (not just no
    // erase-shaped one — Cancel has no submit path to any <Form> at all,
    // so nothing should fire).
    const postsAfterOpen: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST") postsAfterOpen.push(req.url());
    });

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(postsAfterOpen, "Cancel must never send any POST request").toHaveLength(0);
  });
});
