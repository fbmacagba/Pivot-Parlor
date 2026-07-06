/**
 * Stripe webhook for the booking worker — WS-2 reconciliation.
 *
 * Mounted at root level (no auth: Stripe is authenticated by the signed
 * Stripe-Signature header against STRIPE_WEBHOOK_SECRET). Configure the
 * endpoint in the Stripe dashboard pointing at
 * https://pivot-parlor-booking.<account>.workers.dev/webhooks/stripe with the
 * events handled below (plus their Connect variants).
 *
 * Handled events:
 *   account.updated              → flip shops.stripe_connect_onboarded
 *   payment_intent.succeeded     → tx captured; ledger pending → transferred;
 *                                  stamp bw_booking_state.completed_at for the
 *                                  balance PI
 *   charge.refunded              → tx + ledger → refunded
 *   charge.dispute.created       → tx + ledger → disputed
 *
 * Every event id is recorded in processed_stripe_events (INSERT OR IGNORE);
 * a redelivery is acknowledged without re-applying side effects.
 */
import { Hono } from "hono";
import type { Env } from "../types.js";
import { verifyStripeSignature } from "../lib/stripe.js";
import { reportError } from "../services/report-error.js";

const r = new Hono<{ Bindings: Env }>();

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

async function markTransactionsByStripeId(
  db: Env["DB"],
  stripeId: string,
  status: string
): Promise<string | null> {
  // Returns the booking_id of the affected transaction (for ledger updates).
  const tx = await db
    .prepare("SELECT booking_id FROM bw_transactions WHERE stripe_id = ? LIMIT 1")
    .bind(stripeId)
    .first<{ booking_id: string | null }>();
  await db
    .prepare("UPDATE bw_transactions SET status = ? WHERE stripe_id = ?")
    .bind(status, stripeId)
    .run();
  return tx?.booking_id ?? null;
}

async function setLedgerStatus(db: Env["DB"], bookingId: string, from: string | null, to: string) {
  if (from) {
    await db
      .prepare("UPDATE bw_commission_ledger SET status = ? WHERE booking_id = ? AND status = ?")
      .bind(to, bookingId, from)
      .run();
  } else {
    await db
      .prepare("UPDATE bw_commission_ledger SET status = ? WHERE booking_id = ?")
      .bind(to, bookingId)
      .run();
  }
}

r.post("/stripe", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    reportError("webhook.stripe", new Error("STRIPE_WEBHOOK_SECRET not configured"), {});
    return c.json({ success: false, error: "Webhook not configured" }, 500);
  }

  const payload = await c.req.text();
  const valid = await verifyStripeSignature(payload, c.req.header("Stripe-Signature"), secret);
  if (!valid) {
    return c.json({ success: false, error: "Invalid signature" }, 400);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return c.json({ success: false, error: "Invalid payload" }, 400);
  }
  if (!event?.id || !event?.type || !event?.data?.object) {
    return c.json({ success: false, error: "Malformed event" }, 400);
  }

  // Dedup: Stripe retries deliveries; only the first sees changes === 1.
  const dedup = await c.env.DB
    .prepare("INSERT OR IGNORE INTO processed_stripe_events (id, type) VALUES (?, ?)")
    .bind(event.id, event.type)
    .run();
  if ((dedup.meta?.changes ?? 0) === 0) {
    return c.json({ received: true, duplicate: true });
  }

  const db = c.env.DB;
  const obj = event.data.object;

  try {
    switch (event.type) {
      case "account.updated": {
        const accountId = String(obj.id ?? "");
        const onboarded = Boolean(obj.charges_enabled) && Boolean(obj.details_submitted) ? 1 : 0;
        if (accountId) {
          await db
            .prepare("UPDATE shops SET stripe_connect_onboarded = ? WHERE stripe_connect_account_id = ?")
            .bind(onboarded, accountId)
            .run();
        }
        break;
      }

      case "payment_intent.succeeded": {
        const piId = String(obj.id ?? "");
        if (!piId) break;
        const bookingId =
          (await markTransactionsByStripeId(db, piId, "captured")) ??
          (typeof (obj.metadata as Record<string, unknown> | undefined)?.bookingId === "string"
            ? String((obj.metadata as Record<string, unknown>).bookingId)
            : null);
        if (bookingId) {
          // Money has actually settled: the commission is now real.
          await setLedgerStatus(db, bookingId, "pending", "transferred");
          // The balance PI settling marks the checkout fully paid.
          await db
            .prepare(
              `UPDATE bw_booking_state SET completed_at = datetime('now'), updated_at = datetime('now')
               WHERE booking_id = ? AND stripe_balance_pi = ? AND completed_at IS NULL`
            )
            .bind(bookingId, piId)
            .run();
        }
        break;
      }

      case "charge.refunded": {
        const piId = String(obj.payment_intent ?? "");
        if (!piId) break;
        const bookingId = await markTransactionsByStripeId(db, piId, "refunded");
        if (bookingId) await setLedgerStatus(db, bookingId, null, "refunded");
        break;
      }

      case "charge.dispute.created": {
        const piId = String(obj.payment_intent ?? "");
        if (!piId) break;
        const bookingId = await markTransactionsByStripeId(db, piId, "disputed");
        if (bookingId) await setLedgerStatus(db, bookingId, null, "disputed");
        break;
      }

      default:
        // Recorded in processed_stripe_events; nothing to reconcile.
        break;
    }
  } catch (err) {
    // Release the dedup row before returning 500 — otherwise Stripe's retry
    // of this event would be treated as a duplicate and the side effects lost.
    reportError("webhook.stripe_handler", err, { eventId: event.id, eventType: event.type });
    await db.prepare("DELETE FROM processed_stripe_events WHERE id = ?").bind(event.id).run();
    return c.json({ success: false, error: "Handler failed" }, 500);
  }

  return c.json({ received: true });
});

export default r;
