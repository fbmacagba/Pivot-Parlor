-- WS-3 Phase 1: the unified sales spine (audit 2026-07-06 §D).
--
-- One commerce spine: every money event — counter/POS sale AND appointment
-- checkout — is a `sales` header (booking_id nullable) with `sale_items`
-- lines, tendered through bw_transactions and commissioned through
-- bw_commission_ledger. Money is INTEGER pence (D3).
--
-- sales.tender_type: 'cash' and 'card_external' are record-only (the shop
-- takes the money itself; platform commission is ledgered as owed, status
-- 'pending'); 'stripe' pays through a Checkout Session / PaymentIntent on the
-- shop's Connect account (destination charge, application fee = commission)
-- and the ledger flips to 'transferred' on payment_intent.succeeded.
--
-- sale_items.cost_price_pence snapshots COGS at the moment of sale so later
-- catalogue price edits never rewrite margin history. Tips live on the sales
-- header (tip_pence), not as line items.
--
-- Commission uses TWO rates (user decision 2026-07-11): the existing
-- shops.commission_rate for the service portion and the new
-- shops.retail_commission_rate for the product portion — initialised to each
-- shop's current service rate. This supersedes the boolean
-- shop_settings.product_commission_enabled (no longer read).
--
-- These tables reference bw_business_days (migration 019), so like the other
-- bw_-linked tables they live in the migration chain only, not schema.sql.

CREATE TABLE IF NOT EXISTS sales (
  id                         TEXT PRIMARY KEY,
  shop_id                    TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  booking_id                 TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  business_day_id            TEXT REFERENCES bw_business_days(id) ON DELETE SET NULL,
  staff_id                   TEXT REFERENCES staff(id),
  customer_name              TEXT,
  customer_email             TEXT,
  subtotal_pence             INTEGER NOT NULL DEFAULT 0,
  discount_pence             INTEGER NOT NULL DEFAULT 0,
  tax_pence                  INTEGER NOT NULL DEFAULT 0,
  tip_pence                  INTEGER NOT NULL DEFAULT 0,
  total_pence                INTEGER NOT NULL DEFAULT 0,
  tender_type                TEXT NOT NULL CHECK(tender_type IN ('cash','card_external','stripe')),
  stripe_payment_intent_id   TEXT,
  stripe_checkout_session_id TEXT,
  status                     TEXT NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending','completed','refunded','disputed','voided')),
  note                       TEXT,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at               TEXT
);

CREATE TABLE IF NOT EXISTS sale_items (
  id               TEXT PRIMARY KEY,
  sale_id          TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  shop_id          TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  item_type        TEXT NOT NULL CHECK(item_type IN ('service','product')),
  service_id       TEXT REFERENCES services(id),
  product_id       TEXT REFERENCES products(id),
  variant_id       TEXT REFERENCES product_variants(id),
  name             TEXT NOT NULL,
  quantity         INTEGER NOT NULL DEFAULT 1,
  unit_price_pence INTEGER NOT NULL DEFAULT 0,
  cost_price_pence INTEGER NOT NULL DEFAULT 0,
  tax_pence        INTEGER NOT NULL DEFAULT 0,
  line_total_pence INTEGER NOT NULL DEFAULT 0,
  staff_id         TEXT REFERENCES staff(id),
  is_commissionable INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sales_shop_created ON sales(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_booking      ON sales(booking_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale    ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_shop    ON sale_items(shop_id);

ALTER TABLE shops ADD COLUMN retail_commission_rate REAL NOT NULL DEFAULT 0.10;

UPDATE shops SET retail_commission_rate = commission_rate;

ALTER TABLE bw_transactions ADD COLUMN sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL;

ALTER TABLE bw_commission_ledger ADD COLUMN sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL;

ALTER TABLE bw_commission_ledger ADD COLUMN retail_amount_pence INTEGER NOT NULL DEFAULT 0;

ALTER TABLE bw_commission_ledger ADD COLUMN retail_commission_rate REAL;

CREATE INDEX IF NOT EXISTS idx_bw_transactions_sale ON bw_transactions(sale_id);
CREATE INDEX IF NOT EXISTS idx_bw_ledger_sale       ON bw_commission_ledger(sale_id);
