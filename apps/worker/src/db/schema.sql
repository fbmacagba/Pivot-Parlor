-- ─── Shops ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shops (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_number     INTEGER NOT NULL UNIQUE,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'beauty_parlor' CHECK(type IN ('beauty_parlor','barber_shop','both')),
  owner_name      TEXT NOT NULL DEFAULT '',
  owner_email     TEXT NOT NULL UNIQUE,
  phone           TEXT NOT NULL DEFAULT '',
  commission_rate REAL NOT NULL DEFAULT 0.10,
  retail_commission_rate REAL NOT NULL DEFAULT 0.10,
  ai_theme        TEXT,
  ai_model        TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  ai_tier         TEXT NOT NULL DEFAULT 'pro',
  is_active       INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended')),
  plan            TEXT NOT NULL DEFAULT 'standard',
  timezone        TEXT NOT NULL DEFAULT 'Europe/London',
  currency        TEXT NOT NULL DEFAULT 'GBP',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Platform users ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_users (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name          TEXT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('developer','admin','staff','customer')),
  shop_id       TEXT REFERENCES shops(id) ON DELETE CASCADE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Services ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS services (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id      TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  price_pence  INTEGER NOT NULL DEFAULT 0,
  category     TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1
);

-- ─── Staff ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id      TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES platform_users(id),
  display_name TEXT NOT NULL,
  bio          TEXT,
  avatar_url   TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1
);

-- ─── Staff ↔ Services (many-to-many) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_services (
  staff_id   TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

-- ─── Schedules (weekly working hours per staff member) ────────────────────────
CREATE TABLE IF NOT EXISTS schedules (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id     TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id    TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1
);

-- ─── Bookings ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
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
  amount_pence     INTEGER NOT NULL DEFAULT 0,
  commission_pence INTEGER NOT NULL DEFAULT 0,
  reminder_sent   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Waitlist ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waitlist (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id        TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id       TEXT REFERENCES staff(id),
  service_id     TEXT REFERENCES services(id),
  customer_name  TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  preferred_date TEXT,
  status         TEXT NOT NULL DEFAULT 'waiting'
                 CHECK(status IN ('waiting','notified','booked','expired')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bookings_shop        ON bookings(shop_id, booking_date);
CREATE INDEX IF NOT EXISTS idx_bookings_staff       ON bookings(staff_id, booking_date);
CREATE INDEX IF NOT EXISTS idx_schedules_staff      ON schedules(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_shop           ON staff(shop_id);
CREATE INDEX IF NOT EXISTS idx_services_shop        ON services(shop_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_shop        ON waitlist(shop_id);
CREATE INDEX IF NOT EXISTS idx_users_email          ON platform_users(email);

-- ─── Contact enquiries ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  full_name      TEXT NOT NULL,
  shop_name      TEXT NOT NULL,
  shop_type      TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT,
  message        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  onboarded_at   TEXT,
  shop_id        TEXT
);

CREATE INDEX IF NOT EXISTS idx_contacts_email   ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(created_at);

-- ─── Invites ──────────────────────────────────────────────────────────────────
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

-- ─── Legal acceptances (Article 28 posture, migration 043) ────────────────────
-- Auditable record of who accepted the Terms of Service (incorporating the Data
-- Processing Agreement) at onboarding. document = 'terms_dpa' for a shop admin
-- (the controller entering the DPA) or 'terms' for staff/developer.
CREATE TABLE IF NOT EXISTS legal_acceptances (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id     TEXT REFERENCES shops(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  document    TEXT NOT NULL,
  version     TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_legal_acceptances_shop ON legal_acceptances(shop_id);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user ON legal_acceptances(user_id);

-- ─── Inventory: catalogue + stock (WS-3 Phase 0, migration 034) ───────────────
-- Money is INTEGER pence; tax_rate_bps is basis points. stock_levels holds the
-- current quantity; every change is recorded as a stock_movements row.
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

-- ─── Inventory: purchasing + stock-takes + back-bar BOM (WS-3 Phase 2, migration 038) ───

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

CREATE TABLE IF NOT EXISTS service_products (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  shop_id    TEXT NOT NULL,
  quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (service_id, product_id)
);

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_take_items_product
  ON stock_take_items(stock_take_id, product_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_take_items_variant
  ON stock_take_items(stock_take_id, product_id, variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_shop ON purchase_orders(shop_id, status);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);
CREATE INDEX IF NOT EXISTS idx_po_items_shop ON purchase_order_items(shop_id);
CREATE INDEX IF NOT EXISTS idx_service_products_shop ON service_products(shop_id);
CREATE INDEX IF NOT EXISTS idx_service_products_product ON service_products(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_takes_shop ON stock_takes(shop_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_take_items_shop ON stock_take_items(shop_id);
