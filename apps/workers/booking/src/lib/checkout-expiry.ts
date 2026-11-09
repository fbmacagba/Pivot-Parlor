import { expireCheckoutSession } from "./stripe.js";
import { reportError } from "../services/report-error.js";

/**
 * Close a Checkout Session whose booking or sale was just cancelled or
 * voided while still unpaid, so the customer can no longer pay for it.
 * Best effort: it never throws and never changes the caller's answer. For a
 * deposit, a payment that still lands is refunded by the
 * payment_intent.succeeded webhook; this only narrows the window.
 */
export async function expireSessionBestEffort(
  secret: string,
  sessionId: string | null | undefined,
  ref: { bookingId: string } | { saleId: string }
): Promise<void> {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return;
  try {
    await expireCheckoutSession(secret, id);
  } catch (err) {
    reportError("checkout.session_expire", err, ref);
  }
}
