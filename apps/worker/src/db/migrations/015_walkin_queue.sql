-- Migration 015: walk-in queue system
CREATE TABLE IF NOT EXISTS walkin_queue (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id     TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  phone       TEXT,
  service     TEXT,
  status      TEXT NOT NULL DEFAULT 'waiting'
              CHECK(status IN ('waiting','serving','served','skipped','removed')),
  position    INTEGER NOT NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_walkin_shop_status ON walkin_queue(shop_id, status, position);
