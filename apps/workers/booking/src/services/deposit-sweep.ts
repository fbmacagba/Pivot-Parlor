/**
 * Deposit-expiry sweep (migration 041): cancel pending-payment bookings whose
 * Checkout Session has lapsed unpaid, releasing their slot.
 *
 * The checkout.session.expired webhook is the prompt path; this cron-driven
 * sweep is the backstop for missed deliveries. Sessions expire 31 minutes
 * after creation, so anything still unpaid past 40 minutes is dead.
 *
 * Exported as a plain function so tests drive it directly with the test DB.
 */
import type { D1Database } from "@cloudflare/workers-types";

export const DEPOSIT_SWEEP_CUTOFF_MIN = 40;

export async function sweepExpiredDepositBookings(
  db: D1Database,
  nowMs: number = Date.now()
): Promise<number> {
  const cutoffIso = new Date(nowMs - DEPOSIT_SWEEP_CUTOFF_MIN * 60_000).toISOString();
  // updated_at is written at creation and only touched again when the deposit
  // settles, so it is a faithful "session created" clock for unpaid rows.
  const stale = await db
    .prepare(
      `SELECT b.id FROM bookings b
       JOIN bw_booking_state st ON st.booking_id = b.id
       WHERE b.status = 'pending'
         AND st.stripe_checkout_session_id IS NOT NULL
         AND st.deposit_paid_at IS NULL
         AND st.updated_at < ?`
    )
    .bind(cutoffIso)
    .all<{ id: string }>();

  const ids = (stale.results ?? []).map((r) => r.id);
  for (const id of ids) {
    await db.batch([
      db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'pending'").bind(id),
      db
        .prepare(
          "UPDATE bw_transactions SET status = 'cancelled' WHERE booking_id = ? AND type = 'deposit' AND status = 'pending'"
        )
        .bind(id),
    ]);
  }
  return ids.length;
}
