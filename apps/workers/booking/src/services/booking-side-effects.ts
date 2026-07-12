/**
 * Post-booking side effects: confirmation email + reminder enqueue.
 *
 * Extracted from the public booking route so the deposit flow can defer them
 * to payment settlement (stripe-webhook.ts) — a deposit-gated booking must
 * not email "confirmed" or schedule reminders until the money has arrived.
 * Both effects are fire-and-forget: they report failures but never throw.
 */
import type { Env } from "../types.js";
import { sendBookingConfirmation } from "./email.js";
import { reportError } from "./report-error.js";
import { reminderDelaySeconds } from "@repo/utils";

export interface BookingSideEffectArgs {
  bookingId: string;
  shopId: string;
  shopName: string;
  shopSlug: string;
  customerName: string;
  customerEmail: string;
  serviceName: string;
  staffName: string;
  bookingDate: string;
  startISO: string;
  durationMin: number;
  amountPence: number;
}

export async function runBookingSideEffects(env: Env, args: BookingSideEffectArgs): Promise<void> {
  try {
    const confirmPref = await env.DB
      .prepare("SELECT booking_confirmation_email FROM shop_settings WHERE shop_id = ? LIMIT 1")
      .bind(args.shopId)
      .first<{ booking_confirmation_email: number | null }>();
    if (env.RESEND_API_KEY && confirmPref?.booking_confirmation_email !== 0) {
      await sendBookingConfirmation(env.RESEND_API_KEY, {
        customer_name: args.customerName,
        customer_email: args.customerEmail,
        service_name: args.serviceName,
        staff_name: args.staffName,
        shop_name: args.shopName,
        shop_slug: args.shopSlug,
        booking_date: args.bookingDate,
        start_time: args.startISO,
        duration_min: args.durationMin,
        amount_pence: args.amountPence,
        booking_id: args.bookingId,
      });
    }
  } catch (err) {
    // Non-fatal: the booking is already created; the customer just gets no email.
    reportError("booking.confirmation_email", err, { shopId: args.shopId, bookingId: args.bookingId });
  }

  try {
    const settingsRow = await env.DB
      .prepare("SELECT booking_reminder_email, reminder_hours_before FROM shop_settings WHERE shop_id = ? LIMIT 1")
      .bind(args.shopId)
      .first<{ booking_reminder_email: number | null; reminder_hours_before: number | null }>();
    const reminderEnabled = settingsRow?.booking_reminder_email !== 0;
    const hoursBeforeNum = settingsRow?.reminder_hours_before ?? 24;
    const hoursBefore = Number.isFinite(hoursBeforeNum) && hoursBeforeNum > 0 ? hoursBeforeNum : 24;
    if (reminderEnabled) {
      const sendAtDate = new Date(new Date(args.startISO).getTime() - hoursBefore * 60 * 60_000);
      // delaySeconds caps at 12h; the consumer re-delays the remainder in hops.
      await env.QUEUE?.send(
        { bookingId: args.bookingId, sendAt: sendAtDate.toISOString() },
        { delaySeconds: reminderDelaySeconds(sendAtDate, new Date()) }
      );
    }
  } catch (err) {
    // Non-fatal, but the customer will get no reminder for this booking.
    reportError("booking.reminder_enqueue", err, { shopId: args.shopId, bookingId: args.bookingId });
  }
}
