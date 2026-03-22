import { Hono } from "hono";
import Stripe from "stripe";
import type { Bindings } from "../bindings.js";
import {
  getShopByCheckoutSessionId,
  updateShopPaymentComplete,
  setInviteActive,
} from "../db/queries.js";

const webhooks = new Hono<{ Bindings: Bindings }>();

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
    const session = event.data.object as Stripe.Checkout.Session;
    const shopId = session.metadata?.shop_id;
    const inviteId = session.metadata?.invite_id;

    if (!shopId || !inviteId) {
      console.error("[Webhook] Missing metadata in checkout.session.completed", session.id);
      return c.json({ received: true });
    }

    const shop = await getShopByCheckoutSessionId(c.env.DB, session.id);
    if (!shop) {
      console.error("[Webhook] Shop not found for session", session.id);
      return c.json({ received: true });
    }

    await updateShopPaymentComplete(c.env.DB, shopId);
    await setInviteActive(c.env.DB, inviteId);
  }

  return c.json({ received: true });
});

export default webhooks;
