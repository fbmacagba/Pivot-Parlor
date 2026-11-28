import type { Locator, Page } from "@playwright/test";
import { acknowledgePlatformCookieNotice, setE2eCookies } from "./e2e-cookies";
import { expect, test } from "./fixtures";

/**
 * Refund review, end to end on staging, through the real screens.
 *
 * A fresh e2e- shop with an owner and a staff member, and two cash till
 * sales rung through the API (cash, so no payment provider is involved and
 * approving only records that the money was handed back).
 *
 *  1. The staff member asks for a refund on a sale from their Refunds screen,
 *     then adds an evidence file to the waiting request.
 *  2. The owner sees that request with its evidence, and approves it.
 *  3. The owner files a request of their own with no evidence: they cannot
 *     approve it. Once they add evidence, they can.
 *
 * Deposit refunds (the booking page, and the shop cancelling) need a paid
 * deposit and are covered by the booking worker's own tests, not here.
 *
 * Requires DEV_PASSWORD and API_BASE (the staging API worker; set in e2e.yml).
 */

// A 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function signIn(page: Page, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
}

async function session(page: Page): Promise<{ role?: string; shop_id?: string | null; token: string }> {
  const cookie = (await page.context().cookies()).find((c) => c.name === "pp_session");
  if (!cookie) throw new Error("no pp_session cookie: not signed in");
  const payload = JSON.parse(Buffer.from(cookie.value.split(".")[1], "base64url").toString("utf8"));
  return { role: payload.role, shop_id: payload.shop_id, token: cookie.value };
}

/** Fill in and send the "Request a refund" panel that ?sale= opens. */
async function requestRefund(page: Page, reason: string) {
  const panel = page.getByRole("region", { name: "Request a refund on a sale" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("Quantity of E2E Refund Cut to refund").fill("1");
  await panel.getByLabel(/Why is this refund due/).fill(reason);
  await panel.getByRole("button", { name: /^Request refund of £12\.00$/ }).click();
  await expect(panel.getByRole("status")).toContainText("No money has moved", { timeout: 20_000 });
}

/** Attach the PNG through an item's "Add evidence" control. */
async function addEvidence(item: Locator) {
  await item.getByLabel("Add evidence").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await item.getByRole("button", { name: "Attach" }).click();
}

test.describe.serial("refund review", () => {
  const devPassword = process.env.DEV_PASSWORD;
  const apiBase = process.env.API_BASE;
  const uniqueId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const owner = { email: `e2e-refund-owner-${uniqueId}@example.com`, password: `E2e!${uniqueId}Admin9` };
  const staffUser = { email: `e2e-refund-staff-${uniqueId}@example.com`, password: `E2e!${uniqueId}Staff9` };
  const staffReason = `Customer brought it back the same day ${uniqueId}`;
  const ownerReason = `Owner noticed a double charge ${uniqueId}`;
  let shopId = "";
  let staffSale = "";
  let ownerSale = "";

  test.beforeEach(async ({ page }) => {
    await acknowledgePlatformCookieNotice(page);
  });

  test("set up: a shop, its owner, a staff member and two cash sales", async ({ page, context }) => {
    test.setTimeout(120_000);
    if (!devPassword) throw new Error("Missing required env var: DEV_PASSWORD");
    if (!apiBase) throw new Error("Missing required env var: API_BASE");

    // A fresh e2e- shop (scripts/cleanup-e2e-shops.mjs removes it next run).
    await setE2eCookies(context, [{ name: "e2e_legacy_onboard", value: "1" }]);
    await signIn(page, "dev@pivotparlor.com", devPassword);
    await page.goto("/dev/shops");
    await page.getByRole("button", { name: /new shop/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Shop name").fill(`E2E Refunds ${uniqueId}`);
    await page.getByLabel(/owner email/i).fill(owner.email);
    await page.getByRole("button", { name: /create shop/i }).click();
    const inviteLink = page.getByText(/\/invite\/[a-f0-9]{64}/);
    await expect(inviteLink).toBeVisible({ timeout: 15_000 });
    const invitePath = (await inviteLink.textContent())?.match(/\/invite\/[a-f0-9]{64}/)?.[0];
    expect(invitePath, "the create-shop dialog shows an invite link").toBeTruthy();

    await context.clearCookies();
    await page.goto(invitePath!);
    await page.getByLabel("Full name").fill("E2E Refund Owner");
    await page.getByLabel(/^Password$/).fill(owner.password);
    await page.getByLabel(/confirm password/i).fill(owner.password);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /activate account/i }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/invite"), { timeout: 20_000 });
    const me = await session(page);
    expect(me.role).toBe("admin");
    shopId = me.shop_id!;
    expect(shopId).toBeTruthy();

    const headers = { Authorization: `Bearer ${me.token}` };
    const staff = await page.request.post(`${apiBase}/api/shops/${shopId}/staff`, {
      headers,
      data: { display_name: "E2E Refund Staff", email: staffUser.email, password: staffUser.password },
    });
    expect(staff.status(), await staff.text()).toBe(201);

    const service = await page.request.post(`${apiBase}/api/shops/${shopId}/services`, {
      headers,
      data: { name: "E2E Refund Cut", duration_min: 30, price_pence: 1200 },
    });
    expect(service.status(), await service.text()).toBe(201);
    const serviceId = ((await service.json()) as { data: { id: string } }).data.id;

    const ring = async () => {
      const res = await page.request.post(`${apiBase}/api/shops/${shopId}/sales`, {
        headers,
        data: { items: [{ type: "service", serviceId, quantity: 1 }], tender: "cash" },
      });
      expect(res.ok(), await res.text()).toBe(true);
      const sale = ((await res.json()) as { sale?: { id: string; total_pence: number } }).sale;
      expect(sale?.total_pence).toBe(1200);
      return sale!.id;
    };
    staffSale = await ring();
    ownerSale = await ring();
  });

  test("a staff member asks for a refund, then adds evidence to it", async ({ page }) => {
    test.setTimeout(120_000);
    expect(staffSale, "the set-up test rang the sales").toBeTruthy();
    await signIn(page, staffUser.email, staffUser.password);
    expect((await session(page)).role).toBe("staff");

    await page.goto(`/staff/refunds?sale=${staffSale}`);
    await requestRefund(page, staffReason);

    // The request waits under "Your requests", with nowhere to approve it.
    await page.goto("/staff/refunds");
    const mine = page.getByRole("listitem").filter({ hasText: staffReason });
    await expect(mine).toBeVisible();
    await expect(page.getByRole("button", { name: /approve/i })).toHaveCount(0);
    await addEvidence(mine);
    await expect(mine).toContainText("evidence attached", { timeout: 20_000 });
    // Once only: the control is gone.
    await expect(mine.getByLabel("Add evidence")).toHaveCount(0);

    // The owner's review screen is not theirs to open.
    await page.goto("/admin/refunds");
    expect(new URL(page.url()).pathname).not.toBe("/admin/refunds");
  });

  test("the owner approves the staff request, and cannot approve their own without evidence", async ({ page }) => {
    test.setTimeout(180_000);
    expect(ownerSale, "the set-up test rang the sales").toBeTruthy();
    await signIn(page, owner.email, owner.password);
    expect((await session(page)).role).toBe("admin");

    // The owner asks for a refund on the other sale, with no evidence.
    await page.goto(`/admin/sales?sale=${ownerSale}`);
    await requestRefund(page, ownerReason);

    await page.goto("/admin/refunds");
    const waiting = page.getByRole("region", { name: /Waiting for your decision/ });
    const fromStaff = waiting.getByRole("listitem").filter({ hasText: staffReason });
    const own = waiting.getByRole("listitem").filter({ hasText: ownerReason });
    await expect(fromStaff).toBeVisible();
    await expect(own).toBeVisible();

    // The staff request carries its evidence, and the file really opens.
    const evidence = fromStaff.getByRole("link", { name: /View evidence/ });
    await expect(evidence).toBeVisible();
    const file = await page.request.get((await evidence.getAttribute("href"))!);
    expect(file.status()).toBe(200);
    expect(file.headers()["content-type"]).toContain("image/png");

    // Their own request, without evidence: no Approve, and the reason why.
    await expect(own).toContainText("No evidence file was attached.");
    await expect(own).toContainText("you cannot approve it yourself");
    await expect(own.getByRole("button", { name: "Approve refund" })).toHaveCount(0);
    await expect(own.getByRole("button", { name: "Decline" })).toBeVisible();

    // Approve the staff member's request.
    await fromStaff.getByRole("button", { name: "Approve refund" }).click();
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Approve and refund £12\.00$/ }).click();
    const decided = page.getByRole("region", { name: "Decided" });
    await expect(decided.getByRole("listitem").filter({ hasText: staffReason })).toBeVisible({ timeout: 30_000 });
    await expect(fromStaff.getByRole("button", { name: "Approve refund" })).toHaveCount(0);

    // With evidence added, the owner's own request can be approved.
    await addEvidence(own);
    await expect(own.getByRole("link", { name: /View evidence/ })).toBeVisible({ timeout: 20_000 });
    await expect(own).toContainText("records it as self-approved");
    await own.getByRole("button", { name: "Approve refund" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Approve and refund £12\.00$/ }).click();
    await expect(decided.getByRole("listitem").filter({ hasText: ownerReason })).toBeVisible({ timeout: 30_000 });

    // Both sales now read as fully refunded.
    await page.goto(`/admin/sales?sale=${staffSale}`);
    await expect(page.getByRole("region", { name: "Request a refund on a sale" })).toContainText(
      "This sale is fully refunded.",
    );
  });
});
