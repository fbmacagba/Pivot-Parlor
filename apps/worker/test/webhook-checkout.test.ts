import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleCheckoutSessionCompleted } from "../src/routes/webhooks";
import { seedShop } from "./helpers";

/**
 * Stripe checkout.session.completed -> shop activation (the onboarding revenue
 * path). Tests the extracted handler directly so no Stripe signature/crypto is
 * needed. Previously this path had zero unit coverage (audit E2E-15).
 */

async function seedAwaitingPaymentShop() {
  const shopId = await seedShop("Webhook Shop");
  const sessionId = `cs_test_${crypto.randomUUID()}`;
  await env.DB.prepare(
    "UPDATE shops SET stripe_checkout_session_id = ?, stripe_payment_status = 'unpaid', status = 'awaiting_payment' WHERE id = ?"
  )
    .bind(sessionId, shopId)
    .run();
  const inviteId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO invites (id, email, shop_id, role, token, expires_at, active)
     VALUES (?, ?, ?, 'admin', ?, ?, 0)`
  )
    .bind(inviteId, `owner-${inviteId}@test.local`, shopId, `tok-${inviteId}`, new Date(Date.now() + 86_400_000).toISOString())
    .run();
  return { shopId, sessionId, inviteId };
}

describe("Stripe webhook: checkout.session.completed", () => {
  it("marks the shop paid and activates the invite", async () => {
    const { shopId, sessionId, inviteId } = await seedAwaitingPaymentShop();

    const res = await handleCheckoutSessionCompleted(env.DB, {
      id: sessionId,
      metadata: { shop_id: shopId, invite_id: inviteId },
    });
    expect(res.activated).toBe(true);

    const shop = await env.DB
      .prepare("SELECT stripe_payment_status, status FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ stripe_payment_status: string; status: string }>();
    expect(shop?.stripe_payment_status).toBe("paid");
    expect(shop?.status).toBe("pending");

    const invite = await env.DB
      .prepare("SELECT active FROM invites WHERE id = ?")
      .bind(inviteId)
      .first<{ active: number }>();
    expect(invite?.active).toBe(1);
  });

  // Stripe redelivers events. A redelivery after the shop went live must not
  // send it back to pending (which takes the public site down).
  it.each(["active", "suspended"])("a redelivered event leaves a %s shop's status alone", async (status) => {
    const { shopId, sessionId, inviteId } = await seedAwaitingPaymentShop();
    const session = { id: sessionId, metadata: { shop_id: shopId, invite_id: inviteId } };
    await handleCheckoutSessionCompleted(env.DB, session);
    await env.DB.prepare("UPDATE shops SET status = ? WHERE id = ?").bind(status, shopId).run();

    const res = await handleCheckoutSessionCompleted(env.DB, session);
    expect(res.activated).toBe(true);

    const shop = await env.DB
      .prepare("SELECT stripe_payment_status, status FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ stripe_payment_status: string; status: string }>();
    expect(shop).toEqual({ stripe_payment_status: "paid", status });
  });

  it("no-ops when metadata is missing", async () => {
    const res = await handleCheckoutSessionCompleted(env.DB, { id: "cs_x", metadata: {} });
    expect(res.activated).toBe(false);
    expect(res.reason).toBe("missing_metadata");
  });

  it("no-ops when no shop matches the checkout session", async () => {
    const res = await handleCheckoutSessionCompleted(env.DB, {
      id: "cs_unknown",
      metadata: { shop_id: "x", invite_id: "y" },
    });
    expect(res.activated).toBe(false);
    expect(res.reason).toBe("shop_not_found");
  });
});
