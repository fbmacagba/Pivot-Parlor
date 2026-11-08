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
import { cancelPendingBookingStmts } from "../db/queries.js";
import { systemAudit } from "../audit/context.js";

export const DEPOSIT_SWEEP_CUTOFF_MIN = 40;

// Bound the work per cron tick so one invocation can never approach the Workers
// subrequest ceiling (each cancelled booking is one db.batch = one subrequest).
// The sweep runs every 15 min, so any backlog above this drains over the next
// few ticks rather than failing the whole run. miniflare does not enforce the
// ceiling, so an unbounded loop looks fine in tests and only bites at scale.
export const DEPOSIT_SWEEP_MAX_PER_RUN = 200;

export async function sweepExpiredDepositBookings(
  db: D1Database,
  nowMs: number = Date.now(),
  maxPerRun: number = DEPOSIT_SWEEP_MAX_PER_RUN
): Promise<number> {
  const cutoffIso = new Date(nowMs - DEPOSIT_SWEEP_CUTOFF_MIN * 60_000).toISOString();
  // updated_at is written at creation and only touched again when the deposit
  // settles, so it is a faithful "session created" clock for unpaid rows.
  const stale = await db
    .prepare(
      `SELECT b.id, b.shop_id FROM bookings b
       JOIN bw_booking_state st ON st.booking_id = b.id
       WHERE b.status = 'pending'
         AND st.stripe_checkout_session_id IS NOT NULL
         AND st.deposit_paid_at IS NULL
         AND st.updated_at < ?
       ORDER BY st.updated_at, b.id
       LIMIT ?`
    )
    .bind(cutoffIso, maxPerRun)
    .all<{ id: string; shop_id: string }>();

  // One entry per cancelled booking, committed in the SAME batch as the cancel
  // (the guarded batch: see cancelPendingBookingStmts). The cron has no
  // request, so one id ties together everything this tick recorded.
  const audit = systemAudit(db, "cron", crypto.randomUUID());
  let cancelled = 0;
  for (const row of stale.results ?? []) {
    try {
      await audit.batch(cancelPendingBookingStmts(db, row.id), {
        action: "booking.cancel",
        outcome: "succeeded",
        shopId: row.shop_id,
        entityType: "booking",
        entityId: row.id,
        changes: { status: ["pending", "cancelled"] },
        details: { reason: "deposit_expired" },
      });
      cancelled++;
    } catch (err) {
      // The guard rolled the whole batch back because the booking stopped
      // being pending (paid, confirmed or cancelled since the SELECT): nothing
      // changed, so skip it and carry on. Any other failure is real.
      const now = await db
        .prepare("SELECT status FROM bookings WHERE id = ?")
        .bind(row.id)
        .first<{ status: string }>();
      if (now?.status === "pending") throw err;
    }
  }
  return cancelled;
}
