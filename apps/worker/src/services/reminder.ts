import type { D1Database } from "@cloudflare/workers-types";
import { getBookingsDueForReminder, markReminderSent } from "../db/queries.js";
import { sendBookingReminder } from "./email.js";
import { reportError } from "./report-error.js";

export interface ReminderPayload {
  bookingId: string;
  sendAt: string; // ISO string — time the reminder should fire
}

/** Cloudflare Queues maximum delaySeconds (12 hours). */
export const MAX_QUEUE_DELAY_S = 43_200;

/**
 * Seconds to delay a reminder message so it (re)arrives at or after sendAt.
 * Queues cap delays at 12h, so longer waits are made in hops: the producer
 * delays the first 12h and the consumer re-delays (msg.retry) the remainder.
 * Returns 0 when sendAt is due or past.
 */
export function reminderDelaySeconds(sendAt: Date, now: Date): number {
  const remainingS = Math.ceil((sendAt.getTime() - now.getTime()) / 1000);
  if (remainingS <= 0) return 0;
  return Math.min(remainingS, MAX_QUEUE_DELAY_S);
}

/**
 * Process a single reminder payload (called from the Queue consumer).
 * Extend to integrate Resend / SendGrid / Twilio.
 */
export async function processReminder(payload: ReminderPayload, db: D1Database, resendApiKey?: string): Promise<void> {
  const booking = await db
    .prepare(
      `SELECT b.id, b.customer_name, b.customer_email, b.customer_phone,
              b.start_time, b.booking_date, b.notes, b.amount,
              sv.name AS service_name, sv.duration_min,
              st.display_name AS staff_name,
              sh.name AS shop_name, sh.slug AS shop_slug
       FROM bookings b
       JOIN services sv ON sv.id = b.service_id
       JOIN staff st ON st.id = b.staff_id
       JOIN shops sh ON sh.id = b.shop_id
       WHERE b.id = ? AND b.status IN ('pending', 'confirmed') AND b.reminder_sent = 0
       LIMIT 1`
    )
    .bind(payload.bookingId)
    .first<{
      id: string;
      customer_name: string;
      customer_email: string;
      customer_phone: string | null;
      start_time: string;
      booking_date: string;
      notes: string | null;
      amount: number;
      service_name: string;
      duration_min: number;
      staff_name: string;
      shop_name: string;
      shop_slug: string;
    }>();

  if (!booking) return; // already sent or cancelled

  // Send reminder email via Resend
  if (resendApiKey) {
    try {
      await sendBookingReminder(resendApiKey, {
        customer_name:  booking.customer_name,
        customer_email: booking.customer_email,
        service_name:   booking.service_name,
        staff_name:     booking.staff_name,
        shop_name:      booking.shop_name,
        shop_slug:      booking.shop_slug,
        booking_date:   booking.booking_date,
        start_time:     booking.start_time,
        duration_min:   booking.duration_min,
        amount:         booking.amount,
        booking_id:     booking.id,
      });
    } catch (err) {
      // Non-fatal, but the reminder is still marked sent below and will not
      // retry — a failure here means the customer gets no reminder.
      reportError("reminder.email_send", err, { bookingId: booking.id });
    }
  } else {
    console.log(
      `[Reminder] ${booking.customer_name} <${booking.customer_email}> — ` +
      `${booking.service_name} at ${booking.shop_name} on ${booking.booking_date}`
    );
  }

  await markReminderSent(db, booking.id);
}

/**
 * Cron-based fallback: send 24h-ahead reminders for all eligible bookings.
 * Used when Queue is not configured.
 */
export async function sendPendingReminders(db: D1Database, resendApiKey?: string): Promise<void> {
  const bookings = await getBookingsDueForReminder(db);
  await Promise.all(
    bookings.map(async (b) => {
      if (resendApiKey) {
        try {
          await sendBookingReminder(resendApiKey, {
            customer_name:  b.customer_name,
            customer_email: b.customer_email,
            service_name:   b.service_name,
            staff_name:     b.staff_name,
            shop_name:      b.shop_name,
            shop_slug:      b.shop_slug,
            booking_date:   b.booking_date,
            start_time:     b.start_time,
            duration_min:   b.duration_min,
            amount:         b.amount,
            booking_id:     b.id,
          });
        } catch (err) {
          // Non-fatal, but marked sent below — no retry for this booking.
          reportError("reminder.cron_email_send", err, { bookingId: b.id });
        }
      } else {
        console.log(`[Cron Reminder] ${b.customer_name} — ${b.service_name} at ${b.shop_name}`);
      }
      await markReminderSent(db, b.id);
    })
  );
}
