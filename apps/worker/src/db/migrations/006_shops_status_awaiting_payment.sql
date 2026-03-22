-- Migration 006: Expand shops.status CHECK to include 'awaiting_payment'
-- Required for Stripe payment gate. Run after 005_stripe_payment.sql

PRAGMA foreign_keys = OFF;

CREATE TABLE shops_new (
  id TEXT PRIMARY KEY,
  shop_number INTEGER NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'beauty_parlor' CHECK(type IN ('beauty_parlor','barber_shop','both')),
  owner_name TEXT NOT NULL DEFAULT '',
  owner_email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  commission_rate REAL NOT NULL DEFAULT 0.10,
  ai_theme TEXT,
  ai_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  ai_tier TEXT NOT NULL DEFAULT 'pro',
  is_active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','awaiting_payment','active','suspended')),
  plan TEXT NOT NULL DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  stripe_checkout_session_id TEXT,
  stripe_payment_status TEXT DEFAULT 'unpaid',
  stripe_checkout_url TEXT
);

INSERT INTO shops_new SELECT id, shop_number, slug, name, type, owner_name, owner_email, phone, commission_rate, ai_theme, ai_model, ai_tier, is_active, status, plan, created_at, stripe_checkout_session_id, COALESCE(stripe_payment_status, 'unpaid'), stripe_checkout_url FROM shops;

DROP TABLE shops;

ALTER TABLE shops_new RENAME TO shops;

PRAGMA foreign_keys = ON;
