-- Public shop reviews (optional; endpoint returns [] if table missing / error)

CREATE TABLE IF NOT EXISTS reviews (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id       TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  rating        REAL NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reviews_shop_created ON reviews(shop_id, created_at DESC);
