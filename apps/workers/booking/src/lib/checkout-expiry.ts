import { expireCheckoutSession } from "./stripe.js";
import { reportError } from "../services/report-error.js";

/**
 * Close an unpaid deposit booking's Checkout Session after the booking was
 * cancelled, so the customer can no longer pay for a slot that is gone.
 * Best effort: it never throws and never changes the caller's answer. A
 * deposit that still lands is refunded by the payment_intent.succeeded
 * webhook, which is the guarantee; this only narrows the window.
 */
export async function expireSessionBestEffort(
  secret: string,
  sessionId: string | null | undefined,
  bookingId: string
): Promise<void> {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return;
  try {
    await expireCheckoutSession(secret, id);
  } catch (err) {
    reportError("booking.deposit_session_expire", err, { bookingId });
  }
}
