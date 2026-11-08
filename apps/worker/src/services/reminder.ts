import type { D1Database } from "@cloudflare/workers-types";
import type { AuditRecorder } from "@repo/audit";
import { getBookingsDueForReminder, type DueReminder } from "../db/queries.js";
import { systemAudit } from "../audit/context.js";
import { deliverReminder } from "./reminder-deliver.js";
import { reportError } from "./report-error.js";

export interface ReminderPayload {
  bookingId: string;
  sendAt: string; // ISO string — time the reminder should fire
}

// reminderDelaySeconds/MAX_QUEUE_DELAY_S moved to @repo/utils (WS-1) — both
// this worker's queue consumer and the booking worker's producer use them.

/**
 * Process a single reminder payload (called from the Queue consumer).
 * `recorder` defaults to a system recorder via "queue"; the consumer passes
 * one carrying the message id as the entry's request id.
 */
export async function processReminder(
  payload: ReminderPayload,
  db: D1Database,
  resendApiKey?: string,
  recorder: AuditRecorder = systemAudit(db, "queue"),
): Promise<void> {
  const booking = await db
    .prepare(
      `SELECT b.id, b.shop_id, b.customer_name, b.customer_email, b.customer_phone,
              b.start_time, b.booking_date, b.notes, b.amount_pence,
              sv.name AS service_name, sv.duration_min,
              st.display_name AS staff_name,
              sh.name AS shop_name, sh.slug AS shop_slug, sh.timezone AS shop_timezone,
              ss.address AS shop_address
       FROM bookings b
       JOIN services sv ON sv.id = b.service_id
       JOIN staff st ON st.id = b.staff_id
       JOIN shops sh ON sh.id = b.shop_id
       LEFT JOIN shop_settings ss ON ss.shop_id = b.shop_id
       WHERE b.id = ? AND b.status IN ('pending', 'confirmed') AND b.reminder_sent = 0
       LIMIT 1`,
    )
    .bind(payload.bookingId)
    .first<DueReminder>();

  if (!booking) return; // already sent or cancelled

  await deliverReminder(db, resendApiKey, booking, recorder);
}

// Bound one cron run so the fan-out below can never approach the Workers
// subrequest ceiling (each booking costs one Resend send + one D1 batch that
// marks it sent and records the audit entry = 2 subrequests), and cap how many
// sends are in flight at once — the runtime
// allows only 6 simultaneous outbound connections, and an unbounded Promise.all
// over every due booking stampedes that and the email provider's rate limit.
// miniflare enforces neither, so the unbounded version passes tests and only
// bites at scale.
export const REMINDER_MAX_PER_RUN = 500;
export const REMINDER_CONCURRENCY = 20;

/**
 * Cron-based 24h-ahead reminder sweep (08:00 UTC). In steady state the
 * per-booking Queue consumer (processReminder) does the sending; this is the
 * catch-all for stragglers, so it should normally process a small set.
 */
export async function sendPendingReminders(
  db: D1Database,
  resendApiKey?: string,
  recorder: AuditRecorder = systemAudit(db, "cron"),
): Promise<void> {
  const bookings = await getBookingsDueForReminder(db, REMINDER_MAX_PER_RUN);

  if (bookings.length >= REMINDER_MAX_PER_RUN) {
    // A full page means the Queue path is not keeping up (or a burst landed).
    // The overflow is sent on the next run; surface it loudly rather than
    // silently capping — at this volume reminders belong on the queue.
    reportError(
      "reminder.cron_page_full",
      new Error(`reminder cron hit its per-run cap of ${REMINDER_MAX_PER_RUN}`),
      { cap: REMINDER_MAX_PER_RUN },
    );
  }

  for (let i = 0; i < bookings.length; i += REMINDER_CONCURRENCY) {
    const wave = bookings.slice(i, i + REMINDER_CONCURRENCY);
    await Promise.all(
      wave.map((b) => deliverReminder(db, resendApiKey, b, recorder, "reminder.cron_email_send")),
    );
  }
}
