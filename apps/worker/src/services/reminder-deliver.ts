import type { D1Database } from "@cloudflare/workers-types";
import { AuditWriteError, type AuditRecorder } from "@repo/audit";
import { markReminderSentStmt, type DueReminder } from "../db/queries.js";
import { sendBookingReminder } from "./email.js";
import { reportError } from "./report-error.js";

/** `HTTP <status>` when the error carries a numeric status, else its name.
 *  Never the message: `reason` is hashed and locked for 6 years. */
function sendFailureReason(err: unknown): string {
  const status =
    err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : undefined;
  if (status !== undefined) return `HTTP ${status}`;
  return err instanceof Error && err.name ? err.name : "Error";
}

/**
 * Send one due reminder, then commit "reminder marked sent" and its audit
 * entry in ONE batch (Plan 2 Decision 5: after the send, so a booking costs
 * one Resend call plus one D1 batch).
 *
 * Marking semantics are unchanged from before auditing: the booking is marked
 * sent whether or not the send succeeded (a failed send is reported and not
 * retried), and `outcome` is `failed` in that case. The one new behaviour: if
 * the entry cannot be prepared (AuditWriteError), nothing commits, the booking
 * stays unmarked and is retried on the next run; that is logged and swallowed
 * so it cannot abort the cron wave or the queue batch. A failure of the batch
 * itself (including a missing audit_log) propagates unwrapped, exactly as
 * markReminderSent's failure did: the cron rejects, the queue consumer retries
 * the message, and the booking stays unmarked.
 */
export async function deliverReminder(
  db: D1Database,
  resendApiKey: string | undefined,
  booking: DueReminder,
  recorder: AuditRecorder,
  errorTag = "reminder.email_send",
): Promise<void> {
  const channel: "email" | "log_only" = resendApiKey ? "email" : "log_only";
  let sendFailure: string | null = null;

  if (resendApiKey) {
    try {
      await sendBookingReminder(resendApiKey, {
        customer_name: booking.customer_name,
        customer_email: booking.customer_email,
        service_name: booking.service_name,
        staff_name: booking.staff_name,
        shop_name: booking.shop_name,
        shop_slug: booking.shop_slug,
        booking_date: booking.booking_date,
        start_time: booking.start_time,
        timezone: booking.shop_timezone ?? "Europe/London",
        shop_address: booking.shop_address,
        duration_min: booking.duration_min,
        amount_pence: booking.amount_pence,
        booking_id: booking.id,
      });
    } catch (err) {
      // Non-fatal, but the reminder is still marked sent below and will not
      // retry: a failure here means the customer gets no reminder.
      reportError(errorTag, err, { bookingId: booking.id });
      sendFailure = sendFailureReason(err);
    }
  } else {
    console.log(
      `[Reminder] ${booking.customer_name} <${booking.customer_email}> — ` +
        `${booking.service_name} at ${booking.shop_name} on ${booking.booking_date}`,
    );
  }

  try {
    await recorder.batch([markReminderSentStmt(db, booking.id)], {
      action: "booking.reminder",
      outcome: sendFailure ? "failed" : "succeeded",
      reason: sendFailure,
      shopId: booking.shop_id,
      entityType: "booking",
      entityId: booking.id,
      details: { channel, send: sendFailure ? "failed" : "ok" },
    });
  } catch (err) {
    if (err instanceof AuditWriteError) {
      // Not marked sent: retried on the next run.
      console.error("[Reminder] audit entry could not be written; reminder left unmarked", booking.id);
      return;
    }
    throw err;
  }
}
