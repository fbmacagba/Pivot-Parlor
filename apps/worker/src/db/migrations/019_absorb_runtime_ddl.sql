-- Migration 019: absorb runtime DDL from the background workers.
--
-- The booking worker (apps/workers/booking/src/db/ensure-schema.ts) and
-- chatbot worker (apps/workers/chatbot/src/ensure-schema.ts) created tables
-- and columns at runtime, so the database schema was not replayable from
-- migrations alone (NFR-R5). This migration makes the main worker's chain
-- canonical. The workers' ensure-schema files remain as defensive idempotent
-- duplicates for now (everything is IF NOT EXISTS / column-checked there).
--
-- Production/existing databases already have all of this (created by the
-- workers) and are baselined — this file runs only on fresh databases.

-- ── From booking worker ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bw_availability (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  slot_date TEXT NOT NULL,
  slot_time TEXT NOT NULL,
  is_booked INTEGER NOT NULL DEFAULT 0,
  booking_id TEXT,
  UNIQUE (staff_id, slot_date, slot_time)
);

CREATE TABLE IF NOT EXISTS bw_business_days (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL,
  opened_at TEXT,
  closed_at TEXT,
  summary_json TEXT,
  performance_json TEXT,
  UNIQUE (shop_id, date)
);

CREATE TABLE IF NOT EXISTS bw_booking_items (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  service_id TEXT,
  name TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  total_price REAL NOT NULL DEFAULT 0,
  is_commissionable INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bw_transactions (
  id TEXT PRIMARY KEY,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  stripe_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bw_commission_ledger (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  business_day_id TEXT REFERENCES bw_business_days(id) ON DELETE SET NULL,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  services_amount REAL NOT NULL DEFAULT 0,
  commission_rate REAL NOT NULL DEFAULT 0.10,
  commission_amount REAL NOT NULL DEFAULT 0,
  commission_bearer TEXT NOT NULL,
  stripe_transfer_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bw_platform_alerts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  shop_id TEXT REFERENCES shops(id) ON DELETE CASCADE,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS bw_booking_state (
  booking_id TEXT PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  booking_type TEXT NOT NULL DEFAULT 'online',
  deposit_amount REAL NOT NULL DEFAULT 0,
  stripe_payment_intent_id TEXT,
  promo_code TEXT,
  promo_discount_percent REAL,
  qr_code_data TEXT,
  checked_in_at TEXT,
  slot_time TEXT,
  workflow_flag TEXT,
  total_amount REAL,
  stripe_balance_pi TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE shops ADD COLUMN setup_completed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shops ADD COLUMN stripe_connect_onboarded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shops ADD COLUMN stripe_connect_account_id TEXT;
ALTER TABLE shops ADD COLUMN operational_status TEXT NOT NULL DEFAULT 'closed';

ALTER TABLE shop_settings ADD COLUMN address TEXT;
ALTER TABLE shop_settings ADD COLUMN hours_json TEXT;
ALTER TABLE shop_settings ADD COLUMN sells_products INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_settings ADD COLUMN promo_discount_code TEXT;
ALTER TABLE shop_settings ADD COLUMN promo_discount_percent REAL;

ALTER TABLE services ADD COLUMN service_type TEXT NOT NULL DEFAULT 'service';

-- ── From chatbot worker ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  messages_json TEXT NOT NULL DEFAULT '[]',
  booking_initiated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id TEXT PRIMARY KEY,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  worker_name TEXT NOT NULL,
  model TEXT NOT NULL,
  usage_type TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE shop_settings ADD COLUMN promo_active INTEGER NOT NULL DEFAULT 0;
