-- Migration 012: staff_time_off
-- Tracks time-off requests submitted by staff members.
-- Run: npx wrangler d1 execute pivot-parlor-db --remote --file=apps/worker/src/db/migrations/012_staff_time_off.sql

CREATE TABLE IF NOT EXISTS staff_time_off (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id    TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id   TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  from_date  TEXT NOT NULL,
  to_date    TEXT NOT NULL,
  reason     TEXT,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_time_off_staff  ON staff_time_off(staff_id);
CREATE INDEX IF NOT EXISTS idx_time_off_shop   ON staff_time_off(shop_id);
CREATE INDEX IF NOT EXISTS idx_time_off_status ON staff_time_off(shop_id, status);
