import { readdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
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
 * no errors of its own), the error fallback, an uncaught page error, or a CSP
 * violation (the collector in fixtures.ts).
 *
 * A fresh shop has empty lists, so this proves each screen renders cleanly,
 * not that populated tables do. Load only: nothing is clicked, so nothing is
 * generated, paid for or sent.
 *
 * The screen list comes from apps/web/app/routes at run time: a new dashboard
 * route is swept automatically or fails "every dashboard route is covered".
 *
 * Requires DEV_PASSWORD and API_BASE (the staging API worker; set in e2e.yml).
 */

const ROUTES_DIR = path.resolve(__dirname, "../../apps/web/app/routes");

/** Dashboard route modules that are never swept, with the reason. */
const EXCLUDED: Record<string, string> = {
  "dev.activity.export": "a CSV download with its own enforced policy, not a screen",
};

/** Screens designed to redirect: requested pathname -> the pathname they land on. */
const REDIRECTS: Record<string, string> = {
  "/staff/availability": "/staff/bookings",
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
  const onError = (e: Error) => pageErrors.push(e.message);
  page.on("pageerror", onError);
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
  }
  for (const e of pageErrors) problems.push(`page error: ${e.slice(0, 200)}`);
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
      expect.soft(await screenProblems(page, url), `${mod} at ${url}`).toEqual([]);
    });
  }
}

test.describe("dashboard sweep: wiring", () => {
  test("every dashboard route is covered or excluded with a reason", () => {
    const mods = dashboardModules();
    expect(mods.length).toBeGreaterThan(25);
    for (const mod of Object.keys(EXCLUDED)) expect(mods, `excluded module ${mod} exists`).toContain(mod);
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

  test("account and dev screens, as the developer", async ({ page }) => {
    test.setTimeout(180_000);
    expect(shopId, "the admin test created the shop").toBeTruthy();
    await signIn(page, "dev@pivotparlor.com", devPassword!);
    expect((await session(page)).role).toBe("developer");
    await sweep(page, dashboardModules().filter((m) => roleFor(m) === "developer" && !(m in EXCLUDED)), shopId);
  });
});
