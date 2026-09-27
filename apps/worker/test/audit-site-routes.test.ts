import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedShop, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";
import { AUDIT_REFUSED_MESSAGE } from "../src/audit/context";

async function devToken() {
  const id = await seedUser("developer", null);
  return { id, token: await tokenFor(id, "developer", null) };
}

async function seedSite(shopId: string, status: string) {
  await env.DB.prepare(
    "INSERT INTO shop_sites (id, shop_id, template, status, website_status) VALUES (?, ?, 'minimal', 'active', ?)"
  ).bind(crypto.randomUUID(), shopId, status).run();
}

const entriesFor = (shopId: string, action: string) =>
  env.DB.prepare("SELECT * FROM audit_log WHERE shop_id = ? AND action = ? ORDER BY occurred_at")
    .bind(shopId, action)
    .all<Record<string, unknown>>()
    .then((r) => r.results ?? []);

describe("site routes are audited", () => {
  it("pause records who, what changed, and no gap entry", async () => {
    const { id, token } = await devToken();
    const shopId = await seedShop("Pause Shop");
    await seedSite(shopId, "live");
    const res = await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const [e] = await entriesFor(shopId, "site.pause");
    expect(e).toMatchObject({ outcome: "succeeded", actor_type: "developer", actor_ref: `subj_user_${id}`, phase: "done" });
    expect(JSON.parse(e!.changes_json as string)).toEqual({ website_status: ["live", "paused"] });
    const gaps = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.gap' AND request_id = ?")
      .bind(e!.request_id).first<{ n: number }>();
    expect(gaps!.n).toBe(0);
  });

  it("activate records live", async () => {
    const { token } = await devToken();
    const shopId = await seedShop("Activate Shop");
    await seedSite(shopId, "paused");
    const res = await dispatch("POST", `/api/shops/${shopId}/activate`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const [e] = await entriesFor(shopId, "site.activate");
    expect(JSON.parse(e!.changes_json as string)).toEqual({ website_status: ["paused", "live"] });
  });

  it("activate with no active site row records no changes, only no_site_row", async () => {
    const { token } = await devToken();
    const shopId = await seedShop("Siteless Shop");
    const res = await dispatch("POST", `/api/shops/${shopId}/activate`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const [e] = await entriesFor(shopId, "site.activate");
    expect(e!.changes_json).toBeNull();
    expect(JSON.parse(e!.details_json as string)).toEqual({ no_site_row: true });
  });

  it("pause changes nothing when the audit entry cannot be written", async () => {
    const { token } = await devToken();
    const shopId = await seedShop("Atomic Shop");
    await seedSite(shopId, "live");
    await env.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_off").run();
    try {
      const res = await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await env.DB.prepare("ALTER TABLE audit_log_off RENAME TO audit_log").run();
    }
    const site = await env.DB.prepare("SELECT website_status FROM shop_sites WHERE shop_id = ?").bind(shopId).first<{ website_status: string }>();
    expect(site!.website_status).toBe("live");
  });

  it("delete records started + succeeded, schedules blanking, and upserts a shop subject with no name/slug in details", async () => {
    const { token } = await devToken();
    const shopId = await seedShop("Delete Shop");
    const shopRow = await env.DB.prepare("SELECT name, slug FROM shops WHERE id = ?").bind(shopId).first<{ name: string; slug: string }>();
    // A subject id only; no platform_users row, so the shop delete is not blocked by a foreign key.
    const adminId = `u-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO audit_subjects (id, kind, user_id, shop_id, email, created_at) VALUES (?, 'user', ?, ?, 'a@test.local', ?)")
      .bind(`subj_user_${adminId}`, adminId, shopId, new Date().toISOString()).run();
    const res = await dispatch("POST", `/api/shops/${shopId}/delete`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const rows = await entriesFor(shopId, "shop.delete");
    expect(rows.map((r) => [r.phase, r.outcome])).toEqual([["started", null], ["outcome", "succeeded"]]);

    const subj = await env.DB.prepare("SELECT redact_after FROM audit_subjects WHERE id = ?").bind(`subj_user_${adminId}`).first<{ redact_after: string }>();
    expect(Date.parse(subj!.redact_after)).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);

    const shopSubj = await env.DB.prepare("SELECT display_name, redact_after FROM audit_subjects WHERE id = ?")
      .bind(`subj_shop_${shopId}`).first<{ display_name: string; redact_after: string | null }>();
    expect(shopSubj!.display_name).toBe(`${shopRow!.name} (${shopRow!.slug})`);
    expect(Date.parse(shopSubj!.redact_after!)).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);

    const outcome = rows.find((r) => r.phase === "outcome")!;
    const details = JSON.parse(outcome.details_json as string);
    expect(details).toMatchObject({ shop_subject: `subj_shop_${shopId}`, users: 0, bookings: 0 });
    expect(details).toHaveProperty("type");
    expect(details).toHaveProperty("created_at");
    const detailsRaw = outcome.details_json as string;
    expect(detailsRaw).not.toContain(shopRow!.name);
    expect(detailsRaw).not.toContain(shopRow!.slug);
  });

  it("delete refuses (503) when the audit entry cannot be written, leaving the shop and redact_after untouched", async () => {
    const { token } = await devToken();
    const shopId = await seedShop("Refused Delete Shop");
    await env.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_off").run();
    try {
      const res = await dispatch("POST", `/api/shops/${shopId}/delete`, { headers: authHeaders(token) });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ success: false, error: AUDIT_REFUSED_MESSAGE });
    } finally {
      await env.DB.prepare("ALTER TABLE audit_log_off RENAME TO audit_log").run();
    }
    const shop = await env.DB.prepare("SELECT id FROM shops WHERE id = ?").bind(shopId).first<{ id: string }>();
    expect(shop).not.toBeNull();
    const shopSubj = await env.DB.prepare("SELECT redact_after FROM audit_subjects WHERE id = ?")
      .bind(`subj_shop_${shopId}`).first<{ redact_after: string | null }>();
    expect(shopSubj!.redact_after).toBeNull();
  });

  it("delete rolls back the redact schedule when the shop delete itself fails (Ruling 15)", async () => {
    const { token } = await devToken();
    const shopId = await seedShop("Trigger Blocked Shop");
    // Force only the DELETE FROM shops statement to fail. No WHEN clause (and
    // no bound parameter — SQLite trigger bodies reject them: "trigger
    // cannot use variables") is needed: this file's tests run sequentially
    // (no it.concurrent/describe.concurrent here), so a static, unscoped
    // trigger created and dropped within this one test's try/finally never
    // overlaps another test's delete. getShopById/getShopBySlug and every
    // earlier statement in the handler are unaffected either way.
    await env.DB.prepare(
      "CREATE TRIGGER test_block_shop_delete BEFORE DELETE ON shops BEGIN SELECT RAISE(ABORT, 'blocked for test'); END"
    ).run();
    try {
      const res = await dispatch("POST", `/api/shops/${shopId}/delete`, { headers: authHeaders(token) });
      expect(res.status).toBe(500);
    } finally {
      await env.DB.prepare("DROP TRIGGER test_block_shop_delete").run();
    }
    const shop = await env.DB.prepare("SELECT id FROM shops WHERE id = ?").bind(shopId).first<{ id: string }>();
    expect(shop).not.toBeNull();
    const shopSubj = await env.DB.prepare("SELECT redact_after FROM audit_subjects WHERE id = ?")
      .bind(`subj_shop_${shopId}`).first<{ redact_after: string | null }>();
    expect(shopSubj!.redact_after).toBeNull();
    const rows = await entriesFor(shopId, "shop.delete");
    expect(rows.map((r) => [r.phase, r.outcome])).toEqual([["started", null], ["outcome", "failed"]]);
  });

  it("generate-site records failed with the status when it returns an error Response", async () => {
    const { token } = await devToken();
    const shopId = await seedShop("Regen Shop");
    // The test worker has no site_research_queue binding, so the handler returns 503.
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, { headers: authHeaders(token), body: {} });
    expect(res.status).toBe(503);
    const rows = await entriesFor(shopId, "site.regenerate.request");
    const outcome = rows.find((r) => r.phase === "outcome")!;
    expect(outcome).toMatchObject({ outcome: "failed", reason: "HTTP 503" });
    expect(JSON.parse(outcome.details_json as string)).toHaveProperty("job_id");
  });

  it("generate-site logs only the validated template, never a raw unknown one", async () => {
    const { token } = await devToken();
    const shopId = await seedShop("Template Regen Shop");
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: { template: "<script>evil</script>" },
    });
    expect(res.status).toBe(503);
    const rows = await entriesFor(shopId, "site.regenerate.request");
    const started = rows.find((r) => r.phase === "started")!;
    expect(JSON.parse(started.details_json as string).template).toBeNull();
  });
});
