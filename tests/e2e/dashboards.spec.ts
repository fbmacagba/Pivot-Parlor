import { readdirSync } from "node:fs";
import path from "node:path";
import type { Page, Request as PwRequest } from "@playwright/test";
import { acknowledgePlatformCookieNotice, setE2eCookies } from "./e2e-cookies";
import { expect, test } from "./fixtures";

/**
 * Every dashboard screen, opened by the role that uses it, on staging.
 *
 * Admin screens run as a real shop admin (a fresh e2e- shop, its invite
 * accepted through the live invite page), staff screens as a real staff
 * member (created through the shop's own staff API with the admin's
 * session, then signed in), and the account and dev screens as the
 * developer. A screen fails on an HTTP error, a landing page other than the
 * one asked for (an unrecognised session redirects, and a redirect target has
 * no errors of its own), the error fallback, an uncaught page error, a CSP
 * violation (the collector in fixtures.ts), or any error the page's own
 * reporter posts to /client-errors (app/lib/browserErrorReporter.ts), a
 * hydration failure included.
 *
 * The browser runs in UK English but Tokyo time, while the server renders in
 * UTC. A date or time formatted without a fixed locale and time zone then
 * renders differently on the two sides and fails hydration (in UTC, as CI's
 * runner is, the two sides agree by luck). app/lib/dateFormat.ts is the fix.
 *
 * A fresh shop has empty lists, so this proves each screen renders cleanly,
 * not that populated tables do. Load only, with one exception: the
 * developer pass saves the throwaway shop's schedule once, to prove a page
 * action reaches the shop it is viewing. Nothing is generated, paid for or
 * sent.
 *
 * The admin screens run twice: as the shop's admin, and as the developer
 * managing that shop through ?shopId=.
 *
 * The screen list comes from apps/web/app/routes at run time: a new dashboard
 * route is swept automatically or fails "every dashboard route is covered".
 *
 * Requires DEV_PASSWORD and API_BASE (the staging API worker; set in e2e.yml).
 */

const ROUTES_DIR = path.resolve(__dirname, "../../apps/web/app/routes");

// Far from the server's UTC, so an unpinned time zone always shows.
test.use({ locale: "en-GB", timezoneId: "Asia/Tokyo" });

const CLIENT_ERRORS_PATH = "/client-errors";

/** Dashboard route modules that are never swept, with the reason. */
const EXCLUDED: Record<string, string> = {
  "dev.activity.export": "a CSV download with its own enforced policy, not a screen",
};

/**
 * Screens whose designed outcome for the sweep's fresh shop is not a clean
 * render. The problems listed must be EXACTLY what the screen reports, so a
 * crash (500), a wrong landing or a page error still fails it.
 */
const EXPECTED_PROBLEMS: Record<string, { problems: string[]; reason: string }> = {
  "dev.shops.$shopId.preview": {
    problems: ["HTTP 404", "error screen (status 404)"],
    reason:
      "previews a generated site, and the loader answers 404 'No site generated yet' without one. The dev UI shows " +
      "Preview only when has_site (dev.shops._index.tsx), staging has no site pipeline, and generating one is a paid call.",
  },
};

/** Screens designed to redirect: requested pathname -> the pathname they land on. */
const REDIRECTS: Record<string, string> = {
  "/staff/availability": "/staff/bookings",
};

type LoaderData = Record<string, unknown>;

/**
 * Per admin screen, something only the API's answer fills in. The loaders
 * swallow API errors and render empty, so the right shopId alone does not
 * prove the shop's data arrived. Screens missing here have nothing that
 * tells "empty shop" from "no answer": a fresh shop has no bookings, and no
 * settings row, so the public GET /settings answers {} for it.
 */
const ARRIVED: Record<string, (d: LoaderData) => boolean> = {
  "admin._index": (d) => Boolean(d.shopSlug) && d.setupStatus != null,
  "admin.analytics": (d) => d.data != null,
  "admin.payments": (d) => d.status != null,
  "admin.queue": (d) => Boolean(d.shopSlug),
  "admin.revenue": (d) => d.data != null,
  "admin.schedule": (d) => Array.isArray(d.staff) && d.staff.length >= 1,
  "admin.staff": (d) => Array.isArray(d.staff) && d.staff.length >= 1,
};

type Role = "admin" | "staff" | "developer";

function dashboardModules(dir = ROUTES_DIR): string[] {
  const mods = readdirSync(dir)
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
    .map((f) => f.slice(0, -".tsx".length));
  return mods
    .filter((m) => /^(admin|staff|account|dev)(\.|$)/.test(m))
    .filter((m) => !mods.includes(`${m}._index`)) // a layout: its _index child is the screen
    .sort();
}

function roleFor(mod: string): Role {
  if (mod.startsWith("admin")) return "admin";
  if (mod.startsWith("staff")) return "staff";
  return "developer"; // dev.* and account (developer view: there is no customer session here)
}

function pathFor(mod: string, params: { shopId: string }): string {
  const segments = mod
    .split(".")
    .filter((s) => s !== "_index")
    .map((s) => (s === "$shopId" ? params.shopId : s));
  if (segments.some((s) => s.startsWith("$"))) throw new Error(`no value for a param in ${mod}`);
  return `/${segments.join("/")}`;
}

/** Problems on one screen; empty means it rendered cleanly. */
async function screenProblems(page: Page, url: string): Promise<string[]> {
  const problems: string[] = [];
  const pageErrors: string[] = [];
  const browserErrors: string[] = [];
  const onError = (e: Error) => pageErrors.push(e.message);
  // The page reports its own errors here even though the website then drops
  // a headless browser's report as a bot's: seeing the post is enough.
  const onRequest = (req: PwRequest) => {
    if (req.method() !== "POST" || new URL(req.url()).pathname !== CLIENT_ERRORS_PATH) return;
    let report: { kind?: unknown; name?: unknown; message?: unknown } = {};
    try {
      report = req.postDataJSON() ?? {};
    } catch {
      /* reported below as unreadable */
    }
    browserErrors.push(`browser ${String(report.kind)} error: ${String(report.name)}: ${String(report.message).slice(0, 160)}`);
  };
  page.on("pageerror", onError);
  page.on("request", onRequest);
  try {
    const res = await page.goto(url, { waitUntil: "load" });
    if (!res) problems.push("no response");
    else if (res.status() >= 400) problems.push(`HTTP ${res.status()}`);
    // Some screens poll (the queue), so network idle may never come; bounded.
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const want = REDIRECTS[new URL(url, "http://x").pathname] ?? new URL(url, "http://x").pathname;
    const landed = new URL(page.url()).pathname;
    if (landed !== want) problems.push(`landed on ${landed}, not ${want}`);
    const fallback = page.getByTestId("error-screen");
    if (await fallback.count()) problems.push(`error screen (status ${await fallback.first().getAttribute("data-status")})`);
  } finally {
    page.off("pageerror", onError);
    page.off("request", onRequest);
  }
  for (const e of pageErrors) problems.push(`page error: ${e.slice(0, 200)}`);
  for (const e of browserErrors) problems.push(e);
  return problems;
}

async function signIn(page: Page, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
}

/** The signed-in session's claims (pp_session is the app's JWT). */
async function session(page: Page): Promise<{ role?: string; shop_id?: string | null; token: string }> {
  const cookie = (await page.context().cookies()).find((c) => c.name === "pp_session");
  if (!cookie) throw new Error("no pp_session cookie: not signed in");
  const payload = JSON.parse(Buffer.from(cookie.value.split(".")[1], "base64url").toString("utf8"));
  return { role: payload.role, shop_id: payload.shop_id, token: cookie.value };
}

async function sweep(page: Page, mods: string[], shopId: string) {
  for (const mod of mods) {
    const url = pathFor(mod, { shopId });
    await test.step(`${mod} (${url})`, async () => {
      const expected = EXPECTED_PROBLEMS[mod]?.problems ?? [];
      expect.soft(await screenProblems(page, url), `${mod} at ${url}`).toEqual(expected);
    });
  }
}

test.describe("dashboard sweep: wiring", () => {
  test("every dashboard route is covered or excluded with a reason", () => {
    const mods = dashboardModules();
    expect(mods.length).toBeGreaterThan(25);
    for (const mod of Object.keys(EXCLUDED)) expect(mods, `excluded module ${mod} exists`).toContain(mod);
    for (const mod of Object.keys(EXPECTED_PROBLEMS)) expect(mods, `expected-outcome module ${mod} exists`).toContain(mod);
    for (const mod of Object.keys(ARRIVED)) expect(mods, `data-arrived module ${mod} exists`).toContain(mod);
    for (const mod of mods.filter((m) => !(m in EXCLUDED))) {
      expect(() => pathFor(mod, { shopId: "x" }), mod).not.toThrow();
    }
    expect(pathFor("admin._index", { shopId: "s" })).toBe("/admin");
    expect(pathFor("dev.shops.$shopId.preview", { shopId: "s" })).toBe("/dev/shops/s/preview");
    expect(roleFor("account._index")).toBe("developer");
    expect(mods).not.toContain("admin"); // layouts are not screens
  });

  test("control: a signed-out visit is flagged, not passed", async ({ page }) => {
    // requireRole redirects to /login, which renders cleanly: only the
    // landing check catches it.
    expect(await screenProblems(page, "/admin/bookings")).toEqual(
      expect.arrayContaining([expect.stringMatching(/^landed on \/login/)]),
    );
  });

  test("control: the error fallback is flagged", async ({ page }) => {
    // An unknown shop renders the shop layout's ErrorBoundary (ErrorScreen).
    expect(await screenProblems(page, "/no-such-shop-zzz-999")).toEqual(
      expect.arrayContaining(["HTTP 404", "error screen (status 404)"]),
    );
  });
});

test.describe.serial("dashboard sweep", () => {
  const devPassword = process.env.DEV_PASSWORD;
  const apiBase = process.env.API_BASE;
  const uniqueId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const admin = { email: `e2e-dash-owner-${uniqueId}@example.com`, password: `E2e!${uniqueId}Admin9` };
  const staffUser = { email: `e2e-dash-staff-${uniqueId}@example.com`, password: `E2e!${uniqueId}Staff9` };
  let shopId = "";

  test.beforeEach(async ({ page }) => {
    await acknowledgePlatformCookieNotice(page);
  });

  test("admin screens, as the shop's admin", async ({ page, context }) => {
    test.setTimeout(240_000);
    if (!devPassword) throw new Error("Missing required env var: DEV_PASSWORD");
    if (!apiBase) throw new Error("Missing required env var: API_BASE");

    // A fresh e2e- shop (scripts/cleanup-e2e-shops.mjs removes it next run).
    await setE2eCookies(context, [{ name: "e2e_legacy_onboard", value: "1" }]);
    await signIn(page, "dev@pivotparlor.com", devPassword);
    await page.goto("/dev/shops");
    await page.getByRole("button", { name: /new shop/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Shop name").fill(`E2E Dashboards ${uniqueId}`);
    await page.getByLabel(/owner email/i).fill(admin.email);
    await page.getByRole("button", { name: /create shop/i }).click();
    const inviteLink = page.locator("text=pivotparlor.com/invite/");
    await expect(inviteLink).toBeVisible({ timeout: 15_000 });
    const inviteText = await inviteLink.textContent();
    const invitePath = inviteText?.match(/\/invite\/[a-f0-9]{64}/)?.[0];
    expect(invitePath, "the create-shop dialog shows an invite link").toBeTruthy();

    // Accept the invite on the live page: the session becomes the admin's.
    await context.clearCookies();
    await page.goto(invitePath!);
    await page.getByLabel("Full name").fill("E2E Dashboard Owner");
    await page.getByLabel(/^Password$/).fill(admin.password);
    await page.getByLabel(/confirm password/i).fill(admin.password);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /activate account/i }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/invite"), { timeout: 20_000 });
    const me = await session(page);
    expect(me.role).toBe("admin");
    expect(me.shop_id).toBeTruthy();
    shopId = me.shop_id!;

    await sweep(page, dashboardModules().filter((m) => roleFor(m) === "admin" && !(m in EXCLUDED)), shopId);

    // A staff login for the next test, through the shop's own staff API with
    // the admin's authority (no email is sent when a password is given).
    const res = await page.request.post(`${apiBase}/api/shops/${shopId}/staff`, {
      headers: { Authorization: `Bearer ${me.token}` },
      data: { display_name: "E2E Dashboard Staff", email: staffUser.email, password: staffUser.password },
    });
    expect(res.status(), await res.text()).toBe(201);
  });

  test("staff screens, as a staff member of that shop", async ({ page }) => {
    test.setTimeout(120_000);
    expect(shopId, "the admin test created the shop").toBeTruthy();
    await signIn(page, staffUser.email, staffUser.password);
    const me = await session(page);
    expect(me.role).toBe("staff");
    expect(me.shop_id).toBe(shopId);
    await sweep(page, dashboardModules().filter((m) => roleFor(m) === "staff" && !(m in EXCLUDED)), shopId);
  });

  test("admin screens, as the developer managing that shop", async ({ page }) => {
    // A developer has no shop of their own and names one with ?shopId=.
    // Pages that read the session's shop instead rendered empty for them
    // (analytics "No data yet", settings "No shop is assigned").
    test.setTimeout(240_000);
    expect(shopId, "the admin test created the shop").toBeTruthy();
    await signIn(page, "dev@pivotparlor.com", devPassword!);
    expect((await session(page)).role).toBe("developer");
    const q = `?shopId=${encodeURIComponent(shopId)}`;

    for (const mod of dashboardModules().filter((m) => roleFor(m) === "admin" && !(m in EXCLUDED))) {
      const url = `${pathFor(mod, { shopId })}${q}`;
      await test.step(`${mod} (${url})`, async () => {
        const expected = EXPECTED_PROBLEMS[mod]?.problems ?? [];
        expect.soft(await screenProblems(page, url), `${mod} at ${url}`).toEqual(expected);
        // The loader worked on this shop, not on "no shop".
        const res = await page.request.get(`${url}&_data=${encodeURIComponent(`routes/${mod}`)}`);
        expect.soft(res.status(), `${mod} loader status`).toBe(200);
        const data = (await res.json().catch(() => ({}))) as LoaderData;
        expect.soft(data.shopId, `${mod} loader shopId`).toBe(shopId);
        const arrived = ARRIVED[mod];
        if (arrived) expect.soft(arrived(data), `${mod} loaded the shop's data`).toBe(true);
      });
    }

    await test.step("the banner names the shop, and a sidebar link stays on it", async () => {
      await page.goto(`/admin/settings${q}`);
      await expect.soft(page.locator("body")).toContainText(`you are managing E2E Dashboards ${uniqueId} as its admin`);
      await page.getByRole("navigation", { name: "Dashboard" }).getByRole("link", { name: "Bookings", exact: true }).first().click();
      await page.waitForURL((u) => u.pathname === "/admin/bookings");
      expect.soft(new URL(page.url()).searchParams.get("shopId"), "the sidebar link kept ?shopId=").toBe(shopId);
    });

    await test.step("a page action reaches the shop (saving the schedule)", async () => {
      // The one write in this sweep, on the throwaway e2e- shop: the staff
      // member's default hours. A form post with no action keeps ?shopId=.
      await page.goto(`/admin/schedule${q}`, { waitUntil: "networkidle" });
      const button = page.getByRole("button", { name: "Save schedule" });
      // Until the page has hydrated a press does nothing, so press until it posts.
      let posted = "";
      await expect(async () => {
        const request = page.waitForRequest(
          (r) => new URL(r.url()).pathname === "/admin/schedule" && r.method() === "POST",
          { timeout: 5_000 },
        );
        await button.click();
        posted = (await request).url();
      }).toPass({ timeout: 30_000 });
      expect(new URL(posted).searchParams.get("shopId"), "the post kept ?shopId=").toBe(shopId);
      await expect(page.getByRole("status").filter({ hasText: /schedule saved|failed|unauthorized/i })).toHaveText(
        "Schedule saved.",
      );
    });

    await test.step("payments: the developer sees the status, the owner connects Stripe", async () => {
      await page.goto(`/admin/payments${q}`);
      await expect(page.getByText("Only the shop's owner can connect its Stripe account.")).toBeVisible();
      await expect(page.getByRole("button", { name: /stripe/i })).toHaveCount(0);
    });
  });

  test("account and dev screens, as the developer", async ({ page }) => {
    test.setTimeout(180_000);
    expect(shopId, "the admin test created the shop").toBeTruthy();
    await signIn(page, "dev@pivotparlor.com", devPassword!);
    expect((await session(page)).role).toBe("developer");
    await sweep(page, dashboardModules().filter((m) => roleFor(m) === "developer" && !(m in EXCLUDED)), shopId);
  });
});
