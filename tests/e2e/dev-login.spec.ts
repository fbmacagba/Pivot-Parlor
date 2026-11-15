import { acknowledgePlatformCookieNotice } from "./e2e-cookies";
import { expect, test } from "./fixtures";

test.describe("Dev login", () => {
  test("Page load — /login renders and shows submit button", async ({
    page,
  }) => {
    await page.goto("/login");

    await expect(page).toHaveTitle(/Pivot Parlor/);
    await expect(
      page.getByRole("button", { name: /sign in/i })
    ).toBeVisible();
  });

  test("Successful login — redirects to /dev/dashboard", async ({
    page,
  }) => {
    const password = process.env.DEV_PASSWORD;
    if (!password) throw new Error("Missing required env var: DEV_PASSWORD");

    await page.goto("/login");

    await page.getByLabel("Email address").fill("dev@pivotparlor.com");
    await page.getByLabel("Password").fill(password);

    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForLoadState("networkidle");

    await expect(page).toHaveURL(/\/dev\/dashboard/);
  });

  test("Sign in and sign out, by document form and by data request: the session cookie comes and goes", async ({
    page,
    context,
  }) => {
    const password = process.env.DEV_PASSWORD;
    if (!password) throw new Error("Missing required env var: DEV_PASSWORD");
    const sessionCookie = async () => (await context.cookies()).find((c) => c.name === "pp_session");
    // The cookie notice's fixed bottom bar covers the sidebar's "Log out".
    await acknowledgePlatformCookieNotice(page);
    const signIn = async () => {
      await page.goto("/login");
      await page.getByLabel("Email address").fill("dev@pivotparlor.com");
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL(/\/dev\/dashboard/);
    };

    await page.goto("/login");
    expect(await sessionCookie(), "no session before signing in").toBeUndefined();
    await signIn();
    expect(await sessionCookie(), "signing in sets pp_session").toBeTruthy();

    // The sidebar's "Log out" is a plain HTML form: a document POST to /logout.
    await page.getByRole("button", { name: "Log out" }).filter({ visible: true }).first().click();
    await page.waitForURL((u) => u.pathname === "/login");
    expect(await sessionCookie(), "signing out clears pp_session").toBeUndefined();

    // The way <Form action="/logout"> signs out (the customer account page):
    // the router's own data request, POST /logout.data. Its redirect has to
    // carry the cookies that clear the session.
    await signIn();
    expect(await sessionCookie(), "signing in again sets pp_session").toBeTruthy();
    type RouterWindow = Window & {
      __reactRouterDataRouter?: { navigate(to: string, opts: { formMethod: "post"; formData: FormData }): Promise<void> };
    };
    await page.waitForFunction(() => (window as RouterWindow).__reactRouterDataRouter !== undefined);
    const dataLogout = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/logout.data"
    );
    await page.evaluate(() =>
      (window as RouterWindow).__reactRouterDataRouter?.navigate("/logout", { formMethod: "post", formData: new FormData() })
    );
    expect((await dataLogout).status(), "a data request's redirect").toBe(202);
    await page.waitForURL((u) => u.pathname === "/login");
    expect(await sessionCookie(), "a data-request sign-out clears pp_session").toBeUndefined();

    // Signed out for real: the dashboard sends us back to sign in.
    await page.goto("/dev/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("Failed login — shows an error message", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel("Email address").fill("dev@pivotparlor.com");
    await page.getByLabel("Password").fill("wrong123");

    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForLoadState("networkidle");

    const errorBanner = page.locator('[class*="border-red-500/40"]').first();
    await expect(errorBanner).toBeVisible();
  });
});

