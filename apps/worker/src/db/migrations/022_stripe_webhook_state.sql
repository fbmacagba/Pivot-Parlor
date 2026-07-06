-- WS-2: Stripe webhook reconciliation state.
--
-- processed_stripe_events dedups webhook deliveries (Stripe retries and can
-- deliver an event more than once); handlers INSERT OR IGNORE the event id
-- and skip work when the row already existed.
--
-- bw_booking_state.completed_at records the instant a checkout's money fully
-- settled (synchronous deposit capture, or the balance PaymentIntent's
-- payment_intent.succeeded webhook). bookings.completed_at was dropped by the
-- legacy cleanup; this is its canonical home.

CREATE TABLE IF NOT EXISTS processed_stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE bw_booking_state ADD COLUMN completed_at TEXT;
