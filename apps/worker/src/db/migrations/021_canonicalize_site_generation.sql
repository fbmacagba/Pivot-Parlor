-- Migration 021: canonicalize the site-generation schema that the builder /
-- research / audit workers created at runtime but was never in the chain.
--
-- These are LIVE (read by the audit and main workers, written by the builder)
-- yet only existed on databases where the workers had run. This makes the
-- migration chain describe them so fresh databases match production.
-- (Background workers' runtime DDL stays as defensive idempotent duplicates.)
--
-- Production already has all of this, so on prod every statement is a benign
-- no-op (duplicate column / table already exists); it runs for real on fresh
-- and staging databases.

-- ── shop_sites: SEO + research/marketing columns ───────────────────────────
-- Added at runtime by apps/workers/builder (seo_*) and the research pipeline
-- (trust_signals_json, usps_json, layout_mood, brand_voice). All TEXT, nullable.
ALTER TABLE shop_sites ADD COLUMN seo_title TEXT;
ALTER TABLE shop_sites ADD COLUMN seo_description TEXT;
ALTER TABLE shop_sites ADD COLUMN trust_signals_json TEXT;
ALTER TABLE shop_sites ADD COLUMN usps_json TEXT;
ALTER TABLE shop_sites ADD COLUMN layout_mood TEXT;
ALTER TABLE shop_sites ADD COLUMN brand_voice TEXT;

-- ── shop_settings: location fields written by the settings PATCH ───────────
-- phone/lat/lng are in SHOP_SETTINGS_PATCH_FIELDS (apps/worker/src/routes/shops.ts)
-- so the settings update writes them, but they were only ever added on prod at
-- runtime. Without this the PATCH errors on a fresh database. Types match prod.
ALTER TABLE shop_settings ADD COLUMN phone TEXT;
ALTER TABLE shop_settings ADD COLUMN lat REAL;
ALTER TABLE shop_settings ADD COLUMN lng REAL;

-- ── shop_pages: generated legal/info pages (privacy, terms, cookies) ────────
-- Read by apps/workers/audit (SELECT * FROM shop_pages). Mirrors the live
-- production table exactly.
CREATE TABLE IF NOT EXISTS shop_pages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  page_type TEXT NOT NULL CHECK(page_type IN ('privacy','terms','cookies')),
  content TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(shop_id, page_type)
);
