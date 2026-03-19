-- Migration 002: shop status/plan + invites table

ALTER TABLE shops ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK(status IN ('pending', 'active', 'suspended'));

ALTER TABLE shops ADD COLUMN plan TEXT NOT NULL DEFAULT 'standard';

CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email      TEXT NOT NULL,
  shop_id    TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'admin',
  token      TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invites_token   ON invites(token);
CREATE INDEX IF NOT EXISTS idx_invites_shop_id ON invites(shop_id);
