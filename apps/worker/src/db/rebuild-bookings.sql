-- Bookings table rebuild: add 'in_progress' to the status CHECK so the staff
-- "mark in progress" action stops failing the constraint (500). SQLite cannot
-- ALTER a CHECK, so the table is rebuilt. FK definitions are preserved EXACTLY
-- (shop_id cascades with the shop; staff_id/service_id stay RESTRICT so removing
-- a staff member or service never wipes booking/revenue history).
--
-- foreign_keys=OFF is MANDATORY: D1 enforces FKs (verified on staging), so a
-- plain DROP TABLE bookings would cascade-delete every bw_booking_state,
-- bw_booking_items, and reviews row referencing it. With FKs off the children
-- are preserved and re-bind by name to the renamed table. Apply via
-- `wrangler d1 execute --file` (one connection, so the PRAGMA holds across all
-- statements — validated on staging). NOT run by the migrate.mjs runner.
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
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO bookings_new (id, shop_id, staff_id, service_id, customer_name, customer_email,
  customer_phone, booking_date, start_time, end_time, status, notes, amount, commission, reminder_sent, created_at)
SELECT id, shop_id, staff_id, service_id, customer_name, customer_email,
  customer_phone, booking_date, start_time, end_time, status, notes, amount, commission, reminder_sent, created_at
FROM bookings;

DROP TABLE bookings;
ALTER TABLE bookings_new RENAME TO bookings;

CREATE INDEX IF NOT EXISTS idx_bookings_shop  ON bookings(shop_id, booking_date);
CREATE INDEX IF NOT EXISTS idx_bookings_staff ON bookings(staff_id, booking_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_active_slot
  ON bookings(staff_id, start_time) WHERE status NOT IN ('cancelled', 'no_show');

PRAGMA foreign_keys=ON;
