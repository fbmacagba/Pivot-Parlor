-- Migration 005: Stripe £100 setup fee payment gate

-- Shops: Stripe checkout session + payment status + payment URL
ALTER TABLE shops ADD COLUMN stripe_checkout_session_id TEXT;
ALTER TABLE shops ADD COLUMN stripe_payment_status TEXT DEFAULT 'unpaid';
ALTER TABLE shops ADD COLUMN stripe_checkout_url TEXT;

-- Invites: active flag (0 = inactive until payment confirmed)
ALTER TABLE invites ADD COLUMN active INTEGER DEFAULT 0;

-- Note: shops.status CHECK must include 'awaiting_payment'. If your schema has
-- CHECK(status IN ('pending','active','suspended')), run migration 006 to expand it.
