-- WS-3 Phase 0: inventory catalogue + stock foundation (audit 2026-07-06 §D).
--
-- Catalogue: product_categories, suppliers, products, product_variants.
-- Stock: stock_levels (current quantity) + stock_movements (append-only audit
-- trail; every quantity change is a movement row and stock_levels is updated
-- in the same D1 batch).
--
-- Money is INTEGER pence from birth (decision D3); tax_rate_bps is basis
-- points (2000 = 20% VAT). SKUs are optional but unique per shop when set
-- (partial indexes — SQLite treats NULLs as distinct, so a plain UNIQUE would
-- not deduplicate the no-variant stock rows either, hence the paired partial
-- indexes on stock_levels).
--
-- stock_movements.type already includes 'consumption' (back-bar usage,
-- Phase 2): SQLite cannot ALTER a CHECK constraint later, so the enum ships
-- complete.
--
-- shops.currency backs the existing Shop.currency field in packages/types
-- (audit §D noted the column was missing).

CREATE TABLE IF NOT EXISTS product_categories (
  id         TEXT PRIMARY KEY,
  shop_id    TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id         TEXT PRIMARY KEY,
  shop_id    TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT,
  phone      TEXT,
  notes      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id                 TEXT PRIMARY KEY,
  shop_id            TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  category_id        TEXT REFERENCES product_categories(id) ON DELETE SET NULL,
  supplier_id        TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  name               TEXT NOT NULL,
  description        TEXT,
  brand              TEXT,
  sku                TEXT,
  barcode            TEXT,
  cost_price_pence   INTEGER NOT NULL DEFAULT 0,
  retail_price_pence INTEGER NOT NULL DEFAULT 0,
  tax_rate_bps       INTEGER NOT NULL DEFAULT 0,
  is_professional    INTEGER NOT NULL DEFAULT 0,
  track_stock        INTEGER NOT NULL DEFAULT 1,
  image_url          TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_variants (
  id                 TEXT PRIMARY KEY,
  product_id         TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  shop_id            TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  sku                TEXT,
  barcode            TEXT,
  cost_price_pence   INTEGER NOT NULL DEFAULT 0,
  retail_price_pence INTEGER NOT NULL DEFAULT 0,
  attributes_json    TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_levels (
  id            TEXT PRIMARY KEY,
  shop_id       TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id    TEXT REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity      INTEGER NOT NULL DEFAULT 0,
  reorder_point INTEGER NOT NULL DEFAULT 0,
  reorder_qty   INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id              TEXT PRIMARY KEY,
  shop_id         TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id      TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id      TEXT REFERENCES product_variants(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK(type IN ('receive','sale','adjustment','waste','transfer','return','consumption')),
  quantity_delta  INTEGER NOT NULL CHECK(quantity_delta <> 0),
  unit_cost_pence INTEGER,
  reference_type  TEXT,
  reference_id    TEXT,
  staff_id        TEXT REFERENCES staff(id),
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_shop_sku
  ON products(shop_id, sku) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_shop_sku
  ON product_variants(shop_id, sku) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_levels_product
  ON stock_levels(shop_id, product_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_levels_variant
  ON stock_levels(shop_id, product_id, variant_id) WHERE variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_categories_shop ON product_categories(shop_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_shop          ON suppliers(shop_id);
CREATE INDEX IF NOT EXISTS idx_products_shop           ON products(shop_id);
CREATE INDEX IF NOT EXISTS idx_products_barcode        ON products(shop_id, barcode);
CREATE INDEX IF NOT EXISTS idx_variants_product        ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(shop_id, product_id, created_at);

ALTER TABLE shops ADD COLUMN currency TEXT NOT NULL DEFAULT 'GBP';
