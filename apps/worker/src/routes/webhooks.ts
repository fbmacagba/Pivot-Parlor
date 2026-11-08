import { Hono } from "hono";
import Stripe from "stripe";
import type { D1Database } from "@cloudflare/workers-types";
import { AuditWriteError, type AuditRecorder } from "@repo/audit";
import type { Bindings } from "../bindings.js";
import {
  getShopByCheckoutSessionId,
  updateShopPaymentCompleteStmt,
  setInviteActiveStmt,
} from "../db/queries.js";
import { SYSTEM_ACTOR, auditFor, auditRefused } from "../audit/context.js";
import { fieldChanges } from "../audit/diff.js";

const webhooks = new Hono<{ Bindings: Bindings }>();

const CHECKOUT_COMPLETED = "checkout.session.completed";

/** A Stripe event id or type as recorded: Stripe's own identifier shape, or
 *  null, so a hashed 6-year column never holds anything else. */
const stripeToken = (v: unknown): string | null =>
  typeof v === "string" && /^[A-Za-z0-9_.-]{1,255}$/.test(v) ? v : null;

/**
 * Apply a Stripe `checkout.session.completed` event: mark the shop paid and
 * activate its invite. Extracted from the route so the revenue path can be
 * unit-tested without Stripe signature verification.
 *
 * With a `recorder`, the two updates and the `payment.stripe.webhook` entry
 * commit in one batch, and a refusal (missing metadata, unknown session) is
 * recorded; without one (the unit tests' two-argument call) it records
 * nothing. `eventId` is the Stripe `evt_...` id, recorded in details.
 */
export async function handleCheckoutSessionCompleted(
  db: D1Database,
  session: { id: string; metadata?: Record<string, string | undefined> | null },
  recorder?: AuditRecorder,
  eventId?: string
): Promise<{ activated: boolean; reason?: "missing_metadata" | "shop_not_found" }> {
  // The Stripe event id and type only: never the session id, its URL, the
  // customer, or the event body (spec 3.1).
  const details = { event_id: stripeToken(eventId), event_type: CHECKOUT_COMPLETED };
  const shopIdClaim = session.metadata?.shop_id;
  const inviteId = session.metadata?.invite_id;
  if (!shopIdClaim || !inviteId) {
    console.error("[Webhook] Missing metadata in checkout.session.completed", session.id);
    await recorder?.write({ action: "payment.stripe.webhook", outcome: "refused", reason: "missing_metadata", details });
    return { activated: false, reason: "missing_metadata" };
  }
  const shop = await getShopByCheckoutSessionId(db, session.id);
  if (!shop) {
    console.error("[Webhook] Shop not found for session", session.id);
    await recorder?.write({ action: "payment.stripe.webhook", outcome: "refused", reason: "shop_not_found", details });
    return { activated: false, reason: "shop_not_found" };
  }
  // The shop the checkout session belongs to, never the metadata claim: the
  // entry describes the row this update changes. The metadata invite id is a
  // claim too, so only an invite of that same shop is activated.
  const stmts = [updateShopPaymentCompleteStmt(db, shop.id), setInviteActiveStmt(db, inviteId, shop.id)];
  if (recorder) {
    await recorder.batch(stmts, {
      action: "payment.stripe.webhook",
      outcome: "succeeded",
      shopId: shop.id,
      entityType: "shop",
      entityId: shop.id,
      changes: fieldChanges(shop as unknown as Record<string, unknown>, {
        status: "pending",
        stripe_payment_status: "paid",
      }).changes,
      details,
    });
  } else {
    await db.batch(stmts);
  }
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
    // Workers' Web Crypto is async-only: the sync constructEvent() throws
    // ("SubtleCryptoProvider cannot be used in a synchronous context") on
    // workerd, which made this endpoint 400 every signed event regardless
    // of the configured secret.
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      secret,
      undefined,
      Stripe.createSubtleCryptoProvider()
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid signature";
    return c.json({ error: msg }, 400);
  }

  // Signature verified: every event from here on is recorded. An entry that
  // cannot be written answers 503, so Stripe retries the event; a batch
  // commit failure propagates (a 500), and Stripe retries that too.
  const recorder = auditFor(c, "webhook", SYSTEM_ACTOR);
  try {
    if (event.type === CHECKOUT_COMPLETED) {
      await handleCheckoutSessionCompleted(c.env.DB, event.data.object as Stripe.Checkout.Session, recorder, event.id);
    } else {
      await recorder.write({
        action: "payment.stripe.webhook",
        outcome: "succeeded",
        details: { event_type: stripeToken(event.type), handled: false },
      });
    }
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }

  return c.json({ received: true });
});

export default webhooks;
