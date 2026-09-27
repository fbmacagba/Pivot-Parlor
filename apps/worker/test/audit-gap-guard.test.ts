import { Hono } from "hono";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop } from "./helpers";
import type { Bindings } from "../src/bindings.js";
import { requestId } from "../src/audit/request-id.js";
import { auditGapGuard } from "../src/audit/gap-guard.js";
import { batchWithAudit } from "../src/audit/context.js";

/**
 * A tiny test-only Hono app, wired with the SAME middleware `src/index.ts`
 * registers on `app` (requestId + auditGapGuard("api")), plus two routes
 * that exist only to force the two failure paths Plan rulings 8/9 and the
 * "handler throws" requirement need: a thrown error, and a batchWithAudit
 * whose combined batch fails to commit. Neither failure mode has a real
 * route in the app that reliably reproduces it, so this is the brief's own
 * "tiny test-only Hono app mounted like the real one" option.
 */
function buildTestApp(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use("*", requestId, auditGapGuard("api"));

  app.post("/test/throws", () => {
    throw new Error("boom");
  });

  app.post("/test/batch-fail", async (c) => {
    const badChange = c.env.DB.prepare("INSERT INTO no_such_table (id) VALUES (?)").bind("x");
    const refusal = await batchWithAudit(c, [badChange], { action: "audit.gap", outcome: "succeeded" });
    if (refusal) return refusal;
    return c.json({ success: true }, 201);
  });

  app.onError((err, c) => {
    console.error("[test app] error", c.req.method, c.req.path, err);
    return c.json({ success: false, error: "Internal server error" }, 500);
  });

  return app;
}

async function dispatchApp(
  app: Hono<{ Bindings: Bindings }>,
  method: string,
  path: string
): Promise<Response> {
  const request = new Request(`https://worker.test${path}`, { method });
  const ctx = createExecutionContext();
  const response = await app.fetch(request as never, env as never, ctx as never);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

describe("audit gap guard", () => {
  it("records an audit.gap entry for an un-instrumented mutating request", async () => {
    const res = await dispatch("POST", "/api/contact", {
      headers: { "CF-Connecting-IP": "192.0.2.10" },
      body: { full_name: "Gap Test", shop_name: "Gap", shop_type: "barber_shop", email: "gap@test.local", message: "hi" },
    });
    const row = await env.DB.prepare(
      "SELECT action, outcome, details_json, actor_type, ip_ref FROM audit_log WHERE action = 'audit.gap' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ action: string; outcome: string; details_json: string; actor_type: string; ip_ref: string | null }>();
    expect(row, `no gap entry; contact returned ${res.status}`).not.toBeNull();
    expect(JSON.parse(row!.details_json)).toMatchObject({ method: "POST", route: "/api/contact", status: res.status });
    expect(row!.actor_type).toBe("anonymous");
    expect(row!.ip_ref).not.toBeNull();
  });

  it("skips GET requests and unmatched paths", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.gap'").first<{ n: number }>();
    await dispatch("GET", "/health");
    await dispatch("POST", "/definitely/not/a/route");
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.gap'").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("gives every request an id", async () => {
    const res = await dispatch("GET", "/health");
    expect(res.headers.get("X-Request-Id")).toMatch(/.+/);
  });

  it("ignores a client-supplied X-Request-Id and records the server id on the audit entry", async () => {
    const res = await dispatch("POST", "/api/contact", {
      headers: { "CF-Connecting-IP": "192.0.2.11", "X-Request-Id": "attacker-chosen" },
      body: { full_name: "RID Test", shop_name: "RID", shop_type: "barber_shop", email: "rid@test.local", message: "hi" },
    });
    const serverId = res.headers.get("X-Request-Id");
    expect(serverId).toMatch(/.+/);
    expect(serverId).not.toBe("attacker-chosen");
    const row = await env.DB.prepare(
      "SELECT request_id FROM audit_log WHERE action = 'audit.gap' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ request_id: string | null }>();
    expect(row!.request_id).toBe(serverId);
    expect(row!.request_id).not.toBe("attacker-chosen");
  });

  it("writes no audit.gap row for any 429 rate-limited response (count-based, not just-the-last-row)", async () => {
    const ip = "192.0.2.20";
    const body = { full_name: "RL Test", shop_name: "RL", shop_type: "barber_shop", email: "rl@test.local", message: "hi" };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await dispatch("POST", "/api/contact", { headers: { "CF-Connecting-IP": ip }, body });
      statuses.push(res.status);
    }
    expect(statuses, "expected at least one 429 among the 6 dispatches").toContain(429);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.gap' AND json_extract(details_json, '$.status') = 429"
    ).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("records a webhook-via audit.gap entry for a refused Stripe webhook POST", async () => {
    const res = await dispatch("POST", "/api/webhooks/stripe", { body: { foo: "bar" } });
    expect(res.status).not.toBe(200);
    const row = await env.DB.prepare(
      "SELECT via FROM audit_log WHERE action = 'audit.gap' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ via: string }>();
    expect(row!.via).toBe("webhook");
  });

  it("records the matched route pattern, never the raw path (no token leakage)", async () => {
    const shopId = await seedShop("Gap Route Shop");
    const email = `gap-route-${crypto.randomUUID()}@test.local`;
    const token = `tok${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
    await env.DB.prepare(
      `INSERT INTO invites (id, email, shop_id, role, token, expires_at, active)
       VALUES (?, ?, ?, 'admin', ?, ?, 1)`
    )
      .bind(`invite-${crypto.randomUUID()}`, email, shopId, token, "2999-12-31T23:59:59Z")
      .run();

    // Missing accept_terms -> 400 (not 404/405/429), so the gap guard fires.
    const res = await dispatch("POST", `/api/invites/${token}/accept`, {
      body: { name: "No Consent", password: "correct-horse-staple" },
    });
    expect(res.status).toBe(400);

    const row = await env.DB.prepare(
      "SELECT details_json FROM audit_log WHERE action = 'audit.gap' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ details_json: string }>();
    expect(JSON.parse(row!.details_json).route).toBe("/api/invites/:token/accept");
    expect(row!.details_json).toContain(":token");
    expect(row!.details_json).not.toContain(token);
  });

  it("sets shopId from a :shopId route param when the matched pattern has one", async () => {
    const shopId = "11111111-1111-1111-1111-111111111111";
    const res = await dispatch("DELETE", `/api/shops/${shopId}/walkin`);
    // No auth header. adminWalkin's own auth guard (registered `.use("*", authMiddleware, ...)`
    // inside that sub-router) is what actually responds 401 here — before the leaf DELETE "/"
    // handler is ever reached — so the matched pattern is genuinely that guard's own composed
    // path, "/api/shops/:shopId/walkin/*", not the leaf route's.
    expect(res.status).toBe(401);
    const row = await env.DB.prepare(
      "SELECT shop_id, details_json FROM audit_log WHERE action = 'audit.gap' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ shop_id: string | null; details_json: string }>();
    expect(row!.shop_id).toBe(shopId);
    expect(JSON.parse(row!.details_json).route).toBe("/api/shops/:shopId/walkin/*");
  });

  it("writes a failed audit.gap entry when a handler throws", async () => {
    const app = buildTestApp();
    const res = await dispatchApp(app, "POST", "/test/throws");
    expect(res.status).toBe(500);
    const row = await env.DB.prepare(
      "SELECT outcome, details_json FROM audit_log WHERE action = 'audit.gap' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ outcome: string; details_json: string }>();
    expect(row!.outcome).toBe("failed");
    expect(JSON.parse(row!.details_json)).toMatchObject({ method: "POST", status: 500 });
  });

  it("writes a failed audit.gap entry when batchWithAudit's combined batch fails to commit", async () => {
    const app = buildTestApp();
    const res = await dispatchApp(app, "POST", "/test/batch-fail");
    expect(res.status).toBe(500);
    const row = await env.DB.prepare(
      "SELECT outcome FROM audit_log WHERE action = 'audit.gap' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ outcome: string }>();
    expect(row!.outcome).toBe("failed");
  });
});
