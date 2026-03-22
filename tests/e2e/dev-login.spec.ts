import { expect, test } from "@playwright/test";

test.describe("Dev login", () => {
  test("Page load — /dev/login renders and shows submit button", async ({
    page,
  }) => {
    await page.goto("/dev/login");

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

    await page.goto("/dev/login");

    await page.getByLabel("Email address").fill("dev@pivotparlor.com");
    await page.getByLabel("Password").fill(password);

    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForLoadState("networkidle");

    await expect(page).toHaveURL(/\/dev\/dashboard/);
  });

  test("Failed login — shows an error message", async ({ page }) => {
    await page.goto("/dev/login");

    await page.getByLabel("Email address").fill("dev@pivotparlor.com");
    await page.getByLabel("Password").fill("wrong123");

    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForLoadState("networkidle");

    const errorBanner = page.locator('[class*="border-red-500/40"]').first();
    await expect(errorBanner).toBeVisible();
  });
});

