import { Hono } from "hono";
import Stripe from "stripe";
import type { D1Database } from "@cloudflare/workers-types";
import type { Bindings } from "../bindings.js";
import {
  getShopByCheckoutSessionId,
  updateShopPaymentComplete,
  setInviteActive,
} from "../db/queries.js";

const webhooks = new Hono<{ Bindings: Bindings }>();

/**
 * Apply a Stripe `checkout.session.completed` event: mark the shop paid and
 * activate its invite. Extracted from the route so the revenue path can be
 * unit-tested without Stripe signature verification.
 */
export async function handleCheckoutSessionCompleted(
  db: D1Database,
  session: { id: string; metadata?: Record<string, string | undefined> | null }
): Promise<{ activated: boolean; reason?: "missing_metadata" | "shop_not_found" }> {
  const shopId = session.metadata?.shop_id;
  const inviteId = session.metadata?.invite_id;
  if (!shopId || !inviteId) {
    console.error("[Webhook] Missing metadata in checkout.session.completed", session.id);
    return { activated: false, reason: "missing_metadata" };
  }
  const shop = await getShopByCheckoutSessionId(db, session.id);
  if (!shop) {
    console.error("[Webhook] Shop not found for session", session.id);
    return { activated: false, reason: "shop_not_found" };
  }
  await updateShopPaymentComplete(db, shopId);
  await setInviteActive(db, inviteId);
  return { activated: true };
}

// ─── POST /api/webhooks/stripe — Stripe webhook handler ───────────────────────

webhooks.post("/stripe", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return c.json({ error: "Webhook secret not configured" }, 500);
  }

  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "Missing Stripe-Signature header" }, 400);
  }

  const rawBody = await c.req.raw.clone().text();
  let event: Stripe.Event;

  try {
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY!, {
      httpClient: Stripe.createFetchHttpClient(),
    });
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid signature";
    return c.json({ error: msg }, 400);
  }

  if (event.type === "checkout.session.completed") {
    await handleCheckoutSessionCompleted(c.env.DB, event.data.object as Stripe.Checkout.Session);
  }

  return c.json({ received: true });
});

export default webhooks;
