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
import { runBookingSideEffects } from "../services/booking-side-effects.js";
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
): Promise<{ bookingId: string | null; saleId: string | null }> {
  // Returns the booking/sale of the affected transaction (for ledger updates).
  const tx = await db
    .prepare("SELECT booking_id, sale_id FROM bw_transactions WHERE stripe_id = ? LIMIT 1")
    .bind(stripeId)
    .first<{ booking_id: string | null; sale_id: string | null }>();
  await db
    .prepare("UPDATE bw_transactions SET status = ? WHERE stripe_id = ?")
    .bind(status, stripeId)
    .run();
  return { bookingId: tx?.booking_id ?? null, saleId: tx?.sale_id ?? null };
}

/** Settle a sale (WS-3): status, PI id, ledger, and completion stamp. */
async function settleSale(db: Env["DB"], saleId: string, piId: string) {
  await db
    .prepare(
      `UPDATE sales SET status = 'completed', stripe_payment_intent_id = ?,
         completed_at = COALESCE(completed_at, datetime('now'))
       WHERE id = ? AND status = 'pending'`
    )
    .bind(piId, saleId)
    .run();
  await db
    .prepare("UPDATE bw_transactions SET status = 'captured', stripe_id = ? WHERE sale_id = ? AND status = 'pending'")
    .bind(piId, saleId)
    .run();
  await db
    .prepare("UPDATE bw_commission_ledger SET status = 'transferred' WHERE sale_id = ? AND status = 'pending'")
    .bind(saleId)
    .run();
}

async function setSaleStatus(db: Env["DB"], saleId: string, status: string) {
  await db.prepare("UPDATE sales SET status = ? WHERE id = ?").bind(status, saleId).run();
  await db
    .prepare("UPDATE bw_commission_ledger SET status = ? WHERE sale_id = ?")
    .bind(status, saleId)
    .run();
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
        const metadata = (obj.metadata ?? {}) as Record<string, unknown>;
        const marked = await markTransactionsByStripeId(db, piId, "captured");
        // Sales spine (WS-3): a counter sale's Checkout Session recorded the
        // session id, not the PI id, so the tx lookup misses — the saleId in
        // the PI metadata is the canonical reference either way.
        const saleId =
          marked.saleId ?? (typeof metadata.saleId === "string" ? String(metadata.saleId) : null);
        if (saleId) {
          await settleSale(db, saleId, piId);
        }
        const bookingId =
          marked.bookingId ??
          (typeof metadata.bookingId === "string" ? String(metadata.bookingId) : null);

        // Customer deposit (migration 041): the charge settled, so the
        // booking becomes real — flip pending → confirmed, point the deposit
        // tx at the PI (refunds/disputes resolve by stripe_id), stamp
        // deposit_paid_at (the appointment checkout treats the deposit as a
        // paid credit, never a capturable hold), and only now send the
        // confirmation email + enqueue the reminder.
        if (bookingId && metadata.type === "booking_deposit") {
          await db.batch([
            db
              .prepare(
                "UPDATE bw_transactions SET status = 'captured', stripe_id = ? WHERE booking_id = ? AND type = 'deposit' AND status = 'pending'"
              )
              .bind(piId, bookingId),
            db
              .prepare(
                `UPDATE bw_booking_state SET deposit_paid_at = datetime('now'), stripe_payment_intent_id = ?,
                   updated_at = datetime('now')
                 WHERE booking_id = ? AND deposit_paid_at IS NULL`
              )
              .bind(piId, bookingId),
          ]);
          const flip = await db
            .prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND status = 'pending'")
            .bind(bookingId)
            .run();
          if ((flip.meta?.changes ?? 0) === 1) {
            const details = await db
              .prepare(
                `SELECT b.shop_id, b.customer_name, b.customer_email, b.booking_date, b.start_time, b.amount_pence,
                        s.name AS shop_name, s.slug AS shop_slug,
                        sv.name AS service_name, sv.duration_min,
                        stf.display_name AS staff_name
                 FROM bookings b
                 JOIN shops s ON s.id = b.shop_id
                 JOIN services sv ON sv.id = b.service_id
                 LEFT JOIN staff stf ON stf.id = b.staff_id
                 WHERE b.id = ? LIMIT 1`
              )
              .bind(bookingId)
              .first<{
                shop_id: string; customer_name: string; customer_email: string; booking_date: string;
                start_time: string; amount_pence: number; shop_name: string; shop_slug: string;
                service_name: string; duration_min: number; staff_name: string | null;
              }>();
            if (details) {
              await runBookingSideEffects(c.env, {
                bookingId,
                shopId: details.shop_id,
                shopName: details.shop_name,
                shopSlug: details.shop_slug,
                customerName: details.customer_name,
                customerEmail: details.customer_email,
                serviceName: details.service_name,
                staffName: details.staff_name ?? "your specialist",
                bookingDate: details.booking_date,
                startISO: details.start_time,
                durationMin: details.duration_min,
                amountPence: details.amount_pence,
              });
            }
          }
        }
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

        // Which sale/booking does this charge belong to? The ORIGINAL money tx
        // carries the PI id (settleSale) — refund txs are excluded so a partial
        // refund doesn't resolve to itself.
        const origin = await db
          .prepare("SELECT booking_id, sale_id FROM bw_transactions WHERE stripe_id = ? AND type != 'refund' LIMIT 1")
          .bind(piId)
          .first<{ booking_id: string | null; sale_id: string | null }>();

        if (origin?.sale_id) {
          const saleId = origin.sale_id;
          const pending = await db
            .prepare("SELECT COUNT(*) AS n FROM sale_returns WHERE sale_id = ? AND status = 'pending'")
            .bind(saleId)
            .first<{ n: number }>();

          if ((pending?.n ?? 0) > 0) {
            // API-initiated return(s) (WS-3 Phase 2): the refund is confirmed —
            // settle the return, its refund tx, and the negative ledger
            // reversal rows. refunded_pence was recorded at initiation; the
            // sale flips to 'refunded' only once fully refunded.
            await db.batch([
              db
                .prepare(
                  "UPDATE sale_returns SET status = 'completed', completed_at = datetime('now') WHERE sale_id = ? AND status = 'pending'"
                )
                .bind(saleId),
              db
                .prepare(
                  "UPDATE bw_transactions SET status = 'completed' WHERE sale_id = ? AND type = 'refund' AND status = 'pending'"
                )
                .bind(saleId),
              db
                .prepare(
                  "UPDATE bw_commission_ledger SET status = 'transferred' WHERE sale_id = ? AND status = 'pending' AND commission_amount_pence < 0"
                )
                .bind(saleId),
              db
                .prepare(
                  "UPDATE sales SET status = 'refunded' WHERE id = ? AND status = 'completed' AND refunded_pence >= subtotal_pence - discount_pence"
                )
                .bind(saleId),
            ]);
          } else {
            // Dashboard-initiated refund (no return row of ours). A FULL
            // refund keeps the legacy behaviour; a partial one is left for
            // manual reconciliation — we cannot attribute it to lines.
            const amount = Number(obj.amount ?? 0);
            const amountRefunded = Number(obj.amount_refunded ?? 0);
            if (amount > 0 && amountRefunded >= amount) {
              await markTransactionsByStripeId(db, piId, "refunded");
              await setSaleStatus(db, saleId, "refunded");
            }
          }
          break;
        }

        // Booking-only money (deposits/balances without a sale): legacy path.
        const marked = await markTransactionsByStripeId(db, piId, "refunded");
        if (marked.bookingId) await setLedgerStatus(db, marked.bookingId, null, "refunded");
        break;
      }

      case "checkout.session.expired": {
        // Customer deposit abandoned: the session lapsed unpaid, so the
        // pending booking releases its slot (idx_bookings_active_slot ignores
        // cancelled rows). Guarded on deposit_paid_at so a stale/duplicate
        // event can never cancel a booking whose money actually arrived.
        const sessionId = String(obj.id ?? "");
        const metadata = (obj.metadata ?? {}) as Record<string, unknown>;
        const bookingId = typeof metadata.bookingId === "string" ? metadata.bookingId : null;
        if (!sessionId || !bookingId || metadata.type !== "booking_deposit") break;
        const st = await db
          .prepare(
            `SELECT booking_id FROM bw_booking_state
             WHERE booking_id = ? AND stripe_checkout_session_id = ? AND deposit_paid_at IS NULL LIMIT 1`
          )
          .bind(bookingId, sessionId)
          .first<{ booking_id: string }>();
        if (st) {
          await db.batch([
            db
              .prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
              .bind(bookingId),
            db
              .prepare(
                "UPDATE bw_transactions SET status = 'cancelled' WHERE booking_id = ? AND type = 'deposit' AND status = 'pending'"
              )
              .bind(bookingId),
          ]);
        }
        break;
      }

      case "charge.dispute.created": {
        const piId = String(obj.payment_intent ?? "");
        if (!piId) break;
        const marked = await markTransactionsByStripeId(db, piId, "disputed");
        if (marked.saleId) await setSaleStatus(db, marked.saleId, "disputed");
        if (marked.bookingId) await setLedgerStatus(db, marked.bookingId, null, "disputed");
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
