-- Migration 041 (WS-2 scope-cut closure): customer-facing deposits at booking
-- time. Per-shop configuration on shop_settings (default OFF — shops keep the
-- free public booking flow until an owner enables deposits), plus the charge
-- state the hosted-Checkout deposit flow records on bw_booking_state:
--   stripe_checkout_session_id  — the Checkout Session created at booking
--   deposit_paid_at             — stamped by payment_intent.succeeded; also
--                                 tells the appointment checkout the deposit
--                                 is a paid CREDIT, not a capturable hold
--   deposit_application_fee_pence — platform fee carried on the deposit
--                                 charge, so the balance charge at checkout
--                                 collects exactly the remaining commission.
ALTER TABLE shop_settings ADD COLUMN deposits_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_settings ADD COLUMN deposit_percent INTEGER NOT NULL DEFAULT 50;
ALTER TABLE shop_settings ADD COLUMN deposit_min_pence INTEGER NOT NULL DEFAULT 500;

ALTER TABLE bw_booking_state ADD COLUMN stripe_checkout_session_id TEXT;
ALTER TABLE bw_booking_state ADD COLUMN deposit_paid_at TEXT;
ALTER TABLE bw_booking_state ADD COLUMN deposit_application_fee_pence INTEGER NOT NULL DEFAULT 0;
