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

    // Delete sits under each row's "More" disclosure; open the first row's.
    const firstRow = page.locator('[data-testid="shop-row"]').first();
    await expect(firstRow).toBeVisible({ timeout: 20_000 });
    await firstRow.locator("summary").click();
    await firstRow.getByRole("button", { name: /^Delete$/ }).click();

    // The delete stays locked until the shop's slug is typed.
    const dialog = page.getByRole("dialog");
    const confirmDelete = dialog.getByRole("button", { name: /Delete shop/i });
    await expect(confirmDelete).toBeVisible();
    const slug = (await dialog.getByTestId("delete-shop-slug").textContent())?.trim() ?? "";
    await dialog.getByLabel(/^Type .+ to confirm$/).fill(slug);
    await confirmDelete.click();

    await expect
      .poll(() => deleteResponses.length, { timeout: 20_000, message: "expected a POST to …/delete" })
      .toBeGreaterThan(0);

    // Repro aid: print the delete responses.
    console.log("\n[dev-shop-delete-repro] POST /api/shops/.../delete responses:\n", JSON.stringify(deleteResponses, null, 2));

    const last = deleteResponses[deleteResponses.length - 1]!;
    expect(last.status, `delete must return 200 — got ${last.status}: ${last.body}`).toBe(200);
    // React Router 7: the page's fetcher posts to the route's `.data` URL and
    // gets the router's own format (turbo-stream), not JSON. So read the outcome
    // the way the page does: the dialog closes, and the reloaded list no longer
    // has the shop.
    const deletedId = new URL(last.url).pathname.split("/")[3];
    await expect(confirmDelete).toBeHidden({ timeout: 20_000 });
    type RouterWindow = Window & {
      __reactRouterDataRouter?: { state: { loaderData: Record<string, unknown> } };
    };
    await expect
      .poll(
        () =>
          page.evaluate((id) => {
            const list = (window as RouterWindow).__reactRouterDataRouter?.state.loaderData["routes/dev.shops._index"] as
              | { shops?: Array<{ id: string }> }
              | undefined;
            return list?.shops ? list.shops.some((s) => s.id === id) : null;
          }, deletedId),
        { timeout: 20_000, message: `shop ${deletedId} is still listed after its delete` }
      )
      .toBe(false);
  });
});
