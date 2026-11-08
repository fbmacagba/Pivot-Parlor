import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { seedScheduleDay, seedService, seedShop, seedStaff, tokenFor } from "./helpers";
import { dispatch } from "./request";
import { entriesFor, expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";

const REFUSAL = { success: false, error: "Could not record this action; nothing was changed." };

async function authed(role: string, shopId: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await tokenFor(role, shopId)}` };
}

/** A shop whose whole setup checklist passes. */
async function seedReadyShop(): Promise<string> {
  const shopId = await seedShop("Setup Shop");
  const serviceId = await seedService(shopId);
  const staffId = await seedStaff(shopId);
  await seedScheduleDay(shopId, staffId);
  await env.DB.prepare("INSERT INTO staff_services (staff_id, service_id) VALUES (?, ?)").bind(staffId, serviceId).run();
  await env.DB.prepare("UPDATE shops SET stripe_connect_onboarded = 1 WHERE id = ?").bind(shopId).run();
  await env.DB.prepare("INSERT INTO shop_settings (shop_id, address, hours_json) VALUES (?, '1 High St', '{}')")
    .bind(shopId)
    .run();
  await env.DB.prepare("INSERT INTO shop_sites (id, shop_id, template, status) VALUES (?, ?, 'classic', 'active')")
    .bind(crypto.randomUUID(), shopId)
    .run();
  return shopId;
}

async function setupCompleted(shopId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT setup_completed FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ setup_completed: number }>();
  return Number(row?.setup_completed ?? 0);
}

async function entriesForRequest(res: Response): Promise<Record<string, unknown>[]> {
  const rid = res.headers.get("X-Request-Id");
  expect(rid).toMatch(/.+/);
  const r = await env.DB.prepare("SELECT * FROM audit_log WHERE request_id = ? ORDER BY occurred_at, rowid")
    .bind(rid)
    .all<Record<string, unknown>>();
  return r.results ?? [];
}

async function seedAlert(shopId: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO bw_platform_alerts (id, type, severity, title, message, shop_id) VALUES (?, 'x', 'info', 'T', 'M', ?)"
  )
    .bind(id, shopId)
    .run();
  return id;
}

describe("complete-setup audit", () => {
  it("records shop.setup.complete with the setup_completed change", async () => {
    const shopId = await seedReadyShop();
    const res = await dispatch("POST", `/booking/shops/${shopId}/complete-setup`, {
      headers: await authed("admin", shopId),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, shopId, setup_completed: true });
    const rows = await entriesFor({ action: "shop.setup.complete", shopId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "succeeded",
      actor_type: "admin",
      entity_type: "shop",
      entity_id: shopId,
      worker: "pivot-parlor-booking",
    });
    expect(JSON.parse(rows[0]!.changes_json as string)).toEqual({ setup_completed: [0, 1] });
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("a repeat records succeeded with no changes", async () => {
    const shopId = await seedReadyShop();
    const headers = await authed("admin", shopId);
    await dispatch("POST", `/booking/shops/${shopId}/complete-setup`, { headers });
    const res = await dispatch("POST", `/booking/shops/${shopId}/complete-setup`, { headers });
    expect(res.status).toBe(200);
    const rows = await entriesFor({ action: "shop.setup.complete", shopId });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ outcome: "succeeded" });
    expect(rows[1]!.changes_json).toBeNull();
  });

  it("changes nothing when the entry cannot be written", async () => {
    const shopId = await seedReadyShop();
    const headers = await authed("admin", shopId);
    const res = await withAuditOff(() => dispatch("POST", `/booking/shops/${shopId}/complete-setup`, { headers }));
    // Plan 1 Ruling 9: a failed batch propagates the original error (5xx), so this is not toBe(503).
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await setupCompleted(shopId)).toBe(0);
  });
});

describe("platform alert resolve audit", () => {
  it("records platform.alert.resolve with the alert's shop and the resolved change", async () => {
    const shopId = await seedShop("Alert Shop");
    const alertId = await seedAlert(shopId);
    const res = await dispatch("POST", `/booking/platform/alerts/${alertId}/resolve`, {
      headers: await authed("developer", shopId),
    });
    expect(res.status).toBe(200);
    const rows = await entriesForRequest(res);
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    const outcome = rows.find((r) => r.phase === "outcome")!;
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      actor_type: "developer",
      shop_id: shopId,
      entity_type: "platform_alert",
      entity_id: alertId,
    });
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ resolved: [0, 1] });
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("a second resolve of the same alert records refused", async () => {
    const alertId = await seedAlert(null);
    const headers = await authed("developer", "any-shop");
    const first = await dispatch("POST", `/booking/platform/alerts/${alertId}/resolve`, { headers });
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({ success: true, alertId });
    const second = await dispatch("POST", `/booking/platform/alerts/${alertId}/resolve`, { headers });
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ success: false, error: "Alert not found or already resolved" });
    const secondOutcome = (await entriesForRequest(second)).find((r) => r.phase === "outcome")!;
    expect(secondOutcome).toMatchObject({ outcome: "refused", reason: "HTTP 404", entity_id: alertId });
    expect(secondOutcome.changes_json).toBeNull();
    const firstOutcome = (await entriesForRequest(first)).find((r) => r.phase === "outcome")!;
    expect(firstOutcome).toMatchObject({ outcome: "succeeded", entity_id: alertId });
  });

  it("an unknown alert id answers 404 and records nothing", async () => {
    const unknownId = `no-such-alert-${crypto.randomUUID()}`;
    const res = await dispatch("POST", `/booking/platform/alerts/${unknownId}/resolve`, {
      headers: await authed("developer", "any-shop"),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: "Alert not found or already resolved" });
    expect(await entriesFor({ action: "platform.alert.resolve", entityId: unknownId })).toHaveLength(0);
    expect(await entriesForRequest(res)).toHaveLength(0);
  });

  it("is refused with a 503 when the entry cannot be written, and the alert stays open", async () => {
    const alertId = await seedAlert(null);
    const res = await withAuditOff(async () =>
      dispatch("POST", `/booking/platform/alerts/${alertId}/resolve`, { headers: await authed("developer", "s") })
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    const row = await env.DB.prepare("SELECT resolved FROM bw_platform_alerts WHERE id = ?")
      .bind(alertId)
      .first<{ resolved: number }>();
    expect(row!.resolved).toBe(0);
  });
});

describe("Connect onboarding audit", () => {
  const returnUrl = "https://app.test/return?x=1";
  const refreshUrl = "https://app.test/refresh?x=1";

  it("records payment.connect.onboard with only account_created", async () => {
    const shopId = await seedShop("Connect Shop");
    const res = await dispatch("POST", `/booking/shops/${shopId}/connect/onboard`, {
      headers: await authed("admin", shopId),
      body: { return_url: returnUrl, refresh_url: refreshUrl },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { account_id: "acct_new_1", url: "https://connect.stripe.com/setup/e/test" },
    });
    const rows = await entriesFor({ action: "payment.connect.onboard", shopId });
    const outcome = rows.find((r) => r.phase === "outcome")!;
    expect(outcome).toMatchObject({ outcome: "succeeded", entity_type: "shop", entity_id: shopId });
    expect(JSON.parse(outcome.details_json as string)).toEqual({ account_created: true });
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("onboarding never records the Stripe account id or link URL", async () => {
    const shopId = await seedShop("Connect Shop Two");
    const owner = await env.DB.prepare("SELECT owner_email FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ owner_email: string }>();
    await dispatch("POST", `/booking/shops/${shopId}/connect/onboard`, {
      headers: await authed("admin", shopId),
      body: { return_url: returnUrl, refresh_url: refreshUrl },
    });
    const all = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'payment.connect.onboard' AND shop_id = ?")
      .bind(shopId)
      .all<Record<string, unknown>>();
    expect((all.results ?? []).length).toBeGreaterThan(0);
    for (const row of all.results ?? []) {
      expectNoPersonalData(row, [
        "acct_new_1",
        "https://connect.stripe.com/setup/e/test",
        returnUrl,
        refreshUrl,
        owner!.owner_email,
      ]);
    }
  });

  it("a second onboarding of a shop with an account records account_created false", async () => {
    const shopId = await seedShop("Connect Shop Three");
    await env.DB.prepare("UPDATE shops SET stripe_connect_account_id = 'acct_have_1' WHERE id = ?").bind(shopId).run();
    await dispatch("POST", `/booking/shops/${shopId}/connect/onboard`, {
      headers: await authed("admin", shopId),
      body: { return_url: returnUrl, refresh_url: refreshUrl },
    });
    const outcome = (await entriesFor({ action: "payment.connect.onboard", shopId })).find((r) => r.phase === "outcome")!;
    expect(JSON.parse(outcome.details_json as string)).toEqual({ account_created: false });
  });

  it("is refused with a 503 when the entry cannot be written, and no account is created", async () => {
    const shopId = await seedShop("Connect Shop Four");
    const headers = await authed("admin", shopId);
    const res = await withAuditOff(() =>
      dispatch("POST", `/booking/shops/${shopId}/connect/onboard`, {
        headers,
        body: { return_url: returnUrl, refresh_url: refreshUrl },
      })
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    const row = await env.DB.prepare("SELECT stripe_connect_account_id FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ stripe_connect_account_id: string | null }>();
    expect(row!.stripe_connect_account_id).toBeNull();
  });

  it("an onboard that saved a new account and then failed on the account link records account_created", async () => {
    const shopId = await seedShop("Connect Shop Six");
    const owner = await env.DB.prepare("SELECT owner_email FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ owner_email: string }>();
    const realFetch = globalThis.fetch;
    let linkCalls = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.endsWith("/v1/account_links")) {
        linkCalls += 1;
        return Response.json({ error: { message: "stripe down" } }, { status: 500 });
      }
      return realFetch(input as never, init as never);
    });
    let res: Response;
    try {
      res = await dispatch("POST", `/booking/shops/${shopId}/connect/onboard`, {
        headers: await authed("admin", shopId),
        body: { return_url: returnUrl, refresh_url: refreshUrl },
      });
    } finally {
      spy.mockRestore();
    }
    expect(linkCalls, "the account link was never attempted").toBe(1);
    expect(res.status).toBe(500);
    const saved = await env.DB.prepare("SELECT stripe_connect_account_id AS id FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ id: string | null }>();
    expect(saved?.id, "the created account must have been saved before the link failed").toBe("acct_new_1");
    const rows = await entriesFor({ action: "payment.connect.onboard", shopId });
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    const outcome = rows[1]!;
    expect(outcome).toMatchObject({ outcome: "failed", entity_type: "shop", entity_id: shopId });
    expect(outcome.changes_json).toBeNull();
    expect(JSON.parse(outcome.details_json as string)).toEqual({ account_created: true });
    for (const row of rows) {
      expectNoPersonalData(row, ["acct_new_1", returnUrl, refreshUrl, owner!.owner_email, "stripe down"]);
    }
  });

  it("validation failures (400) write no entry", async () => {
    const shopId = await seedShop("Connect Shop Five");
    const res = await dispatch("POST", `/booking/shops/${shopId}/connect/onboard`, {
      headers: await authed("admin", shopId),
      body: { return_url: "ftp://x", refresh_url: refreshUrl },
    });
    expect(res.status).toBe(400);
    expect(await entriesFor({ action: "payment.connect.onboard", shopId })).toHaveLength(0);
  });
});

describe("Connect status sync audit", () => {
  async function seedWithAccount(): Promise<string> {
    const shopId = await seedShop("Sync Shop");
    await env.DB.prepare("UPDATE shops SET stripe_connect_account_id = 'acct_sync_1' WHERE id = ?").bind(shopId).run();
    return shopId;
  }
  async function onboardedFlag(shopId: string): Promise<number> {
    const row = await env.DB.prepare("SELECT stripe_connect_onboarded AS v FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ v: number }>();
    return Number(row?.v ?? 0);
  }

  it("the status poll that confirms onboarding records payment.connect.sync", async () => {
    const shopId = await seedWithAccount();
    const res = await dispatch("GET", `/booking/shops/${shopId}/connect/status`, {
      headers: await authed("admin", shopId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { onboarded: boolean } };
    expect(body.data.onboarded).toBe(true);
    expect(await onboardedFlag(shopId)).toBe(1);
    const rows = await entriesFor({ action: "payment.connect.sync", shopId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "succeeded", entity_type: "shop", entity_id: shopId, actor_type: "admin" });
    expect(JSON.parse(rows[0]!.changes_json as string)).toEqual({ stripe_connect_onboarded: [0, 1] });
    expectNoPersonalData(rows[0]!, ["acct_sync_1"]);
  });

  it("a status poll that changes nothing writes no entry", async () => {
    const shopId = await seedShop("Sync Shop Idle");
    const res = await dispatch("GET", `/booking/shops/${shopId}/connect/status`, {
      headers: await authed("admin", shopId),
    });
    expect(res.status).toBe(200);
    expect(await entriesFor({ action: "payment.connect.sync", shopId })).toHaveLength(0);
  });

  it("a status poll whose entry cannot be written changes nothing and still answers", async () => {
    const shopId = await seedWithAccount();
    const headers = await authed("admin", shopId);
    const res = await withAuditOff(() => dispatch("GET", `/booking/shops/${shopId}/connect/status`, { headers }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { account_id: string; onboarded: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.account_id).toBe("acct_sync_1");
    expect(body.data.onboarded).toBe(false);
    expect(await onboardedFlag(shopId)).toBe(0);
  });
});
