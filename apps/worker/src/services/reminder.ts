import type { D1Database } from "@cloudflare/workers-types";
import { getBookingsDueForReminder, markReminderSent } from "../db/queries.js";

export interface ReminderPayload {
  bookingId: string;
  sendAt: string; // ISO string — time the reminder should fire
}

/**
 * Process a single reminder payload (called from the Queue consumer).
 * Extend to integrate Resend / SendGrid / Twilio.
 */
export async function processReminder(payload: ReminderPayload, db: D1Database): Promise<void> {
  const booking = await db
    .prepare(
      `SELECT b.id, b.customer_name, b.customer_email, b.customer_phone,
              b.start_time, b.booking_date, b.notes,
              sv.name AS service_name,
              st.display_name AS staff_name,
              sh.name AS shop_name
       FROM bookings b
       JOIN services sv ON sv.id = b.service_id
       JOIN staff st ON st.id = b.staff_id
       JOIN shops sh ON sh.id = b.shop_id
       WHERE b.id = ? AND b.status = 'confirmed' AND b.reminder_sent = 0
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
      service_name: string;
      staff_name: string;
      shop_name: string;
    }>();

  if (!booking) return; // already sent or cancelled

  // TODO: Integrate with email/SMS provider (Resend, Twilio, etc.)
  console.log(
    `[Reminder] ${booking.customer_name} <${booking.customer_email}> — ` +
    `${booking.service_name} at ${booking.shop_name} on ${booking.booking_date} ` +
    `${booking.start_time} with ${booking.staff_name}`
  );

  await markReminderSent(db, booking.id);
}

/**
 * Cron-based fallback: send 24h-ahead reminders for all eligible bookings.
 * Used when Queue is not configured.
 */
export async function sendPendingReminders(db: D1Database): Promise<void> {
  const bookings = await getBookingsDueForReminder(db);
  await Promise.all(
    bookings.map(async (b) => {
      console.log(
        `[Cron Reminder] ${b.customer_name} <${b.customer_email}> — ` +
        `${b.service_name} at ${b.shop_name} on ${b.booking_date} with ${b.staff_name}`
      );
      await markReminderSent(db, b.id);
    })
  );
}
