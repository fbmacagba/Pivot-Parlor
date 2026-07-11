-- 038: WS-3 Phase 2 — purchasing, stock-take sessions, back-bar BOM.
-- All additive. Movement types 'receive' / 'adjustment' / 'consumption' were
-- already in stock_movements' CHECK (034 shipped the full set because SQLite
-- cannot alter CHECKs).

-- ─── Purchase orders ──────────────────────────────────────────────────────────
-- Header total is computed from items on read (SUM(quantity * unit_cost_pence))
-- rather than stored, so it can never drift from the lines.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id          TEXT PRIMARY KEY,
  shop_id     TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  supplier_id TEXT REFERENCES suppliers(id),
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','ordered','partial','received','cancelled')),
  notes       TEXT,
  ordered_at  TEXT,
  received_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id              TEXT PRIMARY KEY,
  po_id           TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  shop_id         TEXT NOT NULL,
  product_id      TEXT NOT NULL REFERENCES products(id),
  variant_id      TEXT REFERENCES product_variants(id),
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  received_qty    INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  unit_cost_pence INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_pence >= 0),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_shop ON purchase_orders(shop_id, status);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);
CREATE INDEX IF NOT EXISTS idx_po_items_shop ON purchase_order_items(shop_id);

-- ─── Back-bar bill of materials ───────────────────────────────────────────────
-- Whole units per service (track colour in e.g. 10ml units if fractions are
-- needed); product-level only — variants are retail packaging, not back-bar.
CREATE TABLE IF NOT EXISTS service_products (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  shop_id    TEXT NOT NULL,
  quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (service_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_service_products_shop ON service_products(shop_id);
CREATE INDEX IF NOT EXISTS idx_service_products_product ON service_products(product_id);

-- ─── Stock-take sessions ──────────────────────────────────────────────────────
-- Counting happens over time in stock_take_items; completing the session emits
-- 'adjustment' movements (reference_type 'stock_take') against the CURRENT
-- level, so sales rung up mid-count stay consistent. expected_qty is the
-- snapshot at entry time, kept for the variance report.
CREATE TABLE IF NOT EXISTS stock_takes (
  id           TEXT PRIMARY KEY,
  shop_id      TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  notes        TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_take_items (
  id            TEXT PRIMARY KEY,
  stock_take_id TEXT NOT NULL REFERENCES stock_takes(id) ON DELETE CASCADE,
  shop_id       TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  variant_id    TEXT,
  expected_qty  INTEGER NOT NULL DEFAULT 0,
  counted_qty   INTEGER NOT NULL CHECK (counted_qty >= 0),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One count per product/variant per session — paired partial unique indexes,
-- same pattern as stock_levels (034).
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_take_items_product
  ON stock_take_items(stock_take_id, product_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_take_items_variant
  ON stock_take_items(stock_take_id, product_id, variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_takes_shop ON stock_takes(shop_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_take_items_shop ON stock_take_items(shop_id);
