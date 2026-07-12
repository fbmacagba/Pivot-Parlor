-- 039: WS-3 Phase 2 — returns/refunds on the sales spine.
-- Chain-only like 035 (these tables reference sales, which lives only in the
-- migration chain because it references bw_business_days) — schema.sql is
-- deliberately untouched.
--
-- A return is per-line: sale_return_items records which sale_items came back
-- and for how much; sale_items.returned_quantity guards over-returning;
-- sales.refunded_pence accumulates so partial refunds keep status 'completed'
-- (the status CHECK from 035 has no 'partially_refunded' and SQLite cannot
-- alter CHECKs) and only a full refund flips the sale to 'refunded'.

CREATE TABLE IF NOT EXISTS sale_returns (
  id                        TEXT PRIMARY KEY,
  shop_id                   TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  sale_id                   TEXT NOT NULL REFERENCES sales(id),
  refund_pence              INTEGER NOT NULL CHECK (refund_pence >= 0),
  commission_reversal_pence INTEGER NOT NULL DEFAULT 0,
  tender_type               TEXT NOT NULL,
  -- pending only for Stripe refunds awaiting charge.refunded; record-only
  -- tenders complete immediately (the shop hands the money back itself).
  status                    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
  stripe_refund_id          TEXT,
  reason                    TEXT,
  created_by                TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at              TEXT
);

CREATE TABLE IF NOT EXISTS sale_return_items (
  id           TEXT PRIMARY KEY,
  return_id    TEXT NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  shop_id      TEXT NOT NULL,
  sale_item_id TEXT NOT NULL REFERENCES sale_items(id),
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  refund_pence INTEGER NOT NULL CHECK (refund_pence >= 0),
  restocked    INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE sales ADD COLUMN refunded_pence INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sale_items ADD COLUMN returned_quantity INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sale_returns_shop ON sale_returns(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_return_items_return ON sale_return_items(return_id);
