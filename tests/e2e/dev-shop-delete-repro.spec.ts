import { expect, test } from "./fixtures";

/** Headed when PLAYWRIGHT_HEADED=1; default headless for automation. */
test.use({ headless: process.env.PLAYWRIGHT_HEADED !== "1" });

test.describe("Dev shops — delete shop (headed repro)", () => {
  test("capture delete POST response", async ({ page }) => {
    const pw = process.env.DEV_PASSWORD;
    test.skip(!pw, "Set DEV_PASSWORD in env or .env (see tests/e2e/dev-login.spec.ts)");

    const deleteResponses: { url: string; status: number; body: string }[] = [];

    page.on("response", async (res) => {
      const req = res.request();
      const u = res.url();
      if (req.method() !== "POST" || !/\/api\/shops\/[^/]+\/delete/.test(u)) return;
      try {
        const body = await res.text();
        deleteResponses.push({ url: u, status: res.status(), body: body.slice(0, 800) });
      } catch {
        deleteResponses.push({ url: u, status: res.status(), body: "(could not read body)" });
      }
    });

    await page.goto("/login");
    await page.getByLabel("Email address").fill("dev@pivotparlor.com");
    await page.getByLabel("Password").fill(pw!);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/dev\//, { timeout: 45_000 });

    await page.goto("/dev/shops");
    await page.waitForLoadState("networkidle");

    const rowDelete = page.getByRole("button", { name: /^Delete$/ }).first();
    await expect(rowDelete).toBeVisible({ timeout: 20_000 });
    await rowDelete.click();

    const confirmDelete = page.getByRole("button", { name: /Delete shop/i });
    await expect(confirmDelete).toBeVisible();
    await confirmDelete.click();

    await expect
      .poll(() => deleteResponses.length, { timeout: 20_000, message: "expected a POST to …/delete" })
      .toBeGreaterThan(0);

    // Repro aid: print the delete responses.
    console.log("\n[dev-shop-delete-repro] POST /api/shops/.../delete responses:\n", JSON.stringify(deleteResponses, null, 2));

    const last = deleteResponses[deleteResponses.length - 1]!;
    expect(last.status, `delete must return 200 — got ${last.status}: ${last.body}`).toBe(200);
    const json = JSON.parse(last.body) as { success?: boolean; error?: string };
    expect(json.success, json.error ?? last.body).toBe(true);
  });
});
