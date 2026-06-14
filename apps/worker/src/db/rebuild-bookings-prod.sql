-- PROD-SPECIFIC bookings rebuild — generated from the LIVE production schema on
-- 2026-06-14. Adds 'in_progress' to the status CHECK so the staff "mark in
-- progress" action (PUT /api/staff/me/bookings/:id/status) stops failing the
-- constraint with a 500. SQLite cannot ALTER a CHECK, so the table is rebuilt.
--
-- WHY THIS IS SEPARATE FROM rebuild-bookings.sql:
-- Production's bookings table carries 10 columns added at runtime by the booking
-- worker's ensure-schema that are NOT in schema.sql / the migration chain:
--   booking_type, deposit_amount, total_amount, stripe_payment_intent_id,
--   qr_code_data, promo_code, promo_discount_percent, checked_in_at,
--   completed_at, updated_at
-- rebuild-bookings.sql only knows the 16 canonical columns, so running it on
-- prod would DROP those 10 payment/Stripe columns. This file mirrors prod's full
-- 26-column schema EXACTLY and changes only the status CHECK. (The underlying
-- schema drift should be reconciled separately via a tracked migration so
-- schema.sql/staging match prod; this file only unblocks in_progress safely.)
--
-- FK SAFETY: D1 enforces foreign keys, so DROP TABLE bookings would cascade to
-- children referencing it. foreign_keys=OFF is kept for parity/safety even
-- though prod's bookings is currently empty and reviews.reviewed_booking_id rows
-- are NULL. Apply via `wrangler d1 execute --file` (one connection, so the
-- PRAGMA holds across every statement). NOT run by the migrate.mjs runner.
PRAGMA foreign_keys=OFF;

CREATE TABLE bookings_new (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id         TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id        TEXT NOT NULL REFERENCES staff(id),
  service_id      TEXT NOT NULL REFERENCES services(id),
  customer_name   TEXT NOT NULL,
  customer_email  TEXT NOT NULL,
  customer_phone  TEXT,
  booking_date    TEXT NOT NULL,
  start_time      TEXT NOT NULL,
  end_time        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','confirmed','in_progress','completed','cancelled','no_show')),
  notes           TEXT,
  amount          REAL NOT NULL,
  commission      REAL NOT NULL,
  reminder_sent   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  booking_type             TEXT NOT NULL DEFAULT 'online',
  deposit_amount           REAL DEFAULT 0,
  total_amount             REAL DEFAULT 0,
  stripe_payment_intent_id TEXT,
  qr_code_data             TEXT,
  promo_code               TEXT,
  promo_discount_percent   INTEGER DEFAULT 0,
  checked_in_at            TEXT,
  completed_at             TEXT,
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO bookings_new (
  id, shop_id, staff_id, service_id, customer_name, customer_email, customer_phone,
  booking_date, start_time, end_time, status, notes, amount, commission, reminder_sent, created_at,
  booking_type, deposit_amount, total_amount, stripe_payment_intent_id, qr_code_data,
  promo_code, promo_discount_percent, checked_in_at, completed_at, updated_at)
SELECT
  id, shop_id, staff_id, service_id, customer_name, customer_email, customer_phone,
  booking_date, start_time, end_time, status, notes, amount, commission, reminder_sent, created_at,
  booking_type, deposit_amount, total_amount, stripe_payment_intent_id, qr_code_data,
  promo_code, promo_discount_percent, checked_in_at, completed_at, updated_at
FROM bookings;

DROP TABLE bookings;
ALTER TABLE bookings_new RENAME TO bookings;

CREATE INDEX IF NOT EXISTS idx_bookings_shop  ON bookings(shop_id, booking_date);
CREATE INDEX IF NOT EXISTS idx_bookings_staff ON bookings(staff_id, booking_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_active_slot
  ON bookings(staff_id, start_time) WHERE status NOT IN ('cancelled', 'no_show');

PRAGMA foreign_keys=ON;
