/**
 * Regression test for the sync-crypto webhook bug: the route used
 * stripe.webhooks.constructEvent(), whose SubtleCryptoProvider throws in a
 * synchronous context on workerd — so every REAL signed event was rejected
 * 400 while the handler-only unit tests stayed green (test/prod parity gap,
 * same class as the PBKDF2 P0).
 *
 * These tests dispatch through the real worker (middleware + the isolated
 * stripeWebhookApp) with genuinely signed payloads, in workerd.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop } from "./helpers";

const TEST_SECRET = "whsec_test_signing_secret"; // must match vitest.config.mts

async function stripeSignatureHeader(payload: string, secret: string, tsSec?: number): Promise<string> {
  const t = tsSec ?? Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

async function postSigned(event: unknown, signature: string): Promise<Response> {
  return dispatch("POST", "/api/webhooks/stripe", {
    headers: { "stripe-signature": signature },
    body: event,
  });
}

describe("POST /api/webhooks/stripe — signature verification (workerd)", () => {
  it("accepts a correctly signed event and activates the shop", async () => {
    const shopId = await seedShop("Signed Webhook Shop");
    const sessionId = `cs_test_${crypto.randomUUID()}`;
    await env.DB.prepare(
      "UPDATE shops SET stripe_checkout_session_id = ?, stripe_payment_status = 'unpaid' WHERE id = ?"
    )
      .bind(sessionId, shopId)
      .run();
    const inviteId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO invites (id, email, shop_id, role, token, expires_at, active)
       VALUES (?, ?, ?, 'admin', ?, ?, 0)`
    )
      .bind(
        inviteId,
        `owner-${inviteId}@test.local`,
        shopId,
        `tok-${inviteId}`,
        new Date(Date.now() + 86_400_000).toISOString()
      )
      .run();

    const event = {
      id: `evt_${crypto.randomUUID()}`,
      type: "checkout.session.completed",
      data: { object: { id: sessionId, metadata: { shop_id: shopId, invite_id: inviteId } } },
    };
    // dispatch() JSON.stringifies the body — sign the identical string.
    const payload = JSON.stringify(event);
    const res = await postSigned(event, await stripeSignatureHeader(payload, TEST_SECRET));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    const shop = await env.DB.prepare("SELECT stripe_payment_status FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ stripe_payment_status: string }>();
    expect(shop?.stripe_payment_status).toBe("paid");
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const event = { id: "evt_x", type: "checkout.session.completed", data: { object: { id: "cs_x" } } };
    const payload = JSON.stringify(event);
    const res = await postSigned(event, await stripeSignatureHeader(payload, "whsec_wrong_secret"));
    expect(res.status).toBe(400);
  });

  it("rejects a stale timestamp (replay window)", async () => {
    const event = { id: "evt_y", type: "checkout.session.completed", data: { object: { id: "cs_y" } } };
    const payload = JSON.stringify(event);
    const staleTs = Math.floor(Date.now() / 1000) - 3600;
    const res = await postSigned(event, await stripeSignatureHeader(payload, TEST_SECRET, staleTs));
    expect(res.status).toBe(400);
  });

  it("rejects a missing signature header", async () => {
    const res = await dispatch("POST", "/api/webhooks/stripe", {
      body: { id: "evt_z", type: "checkout.session.completed" },
    });
    expect(res.status).toBe(400);
  });
});
