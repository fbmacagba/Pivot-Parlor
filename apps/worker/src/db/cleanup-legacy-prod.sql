-- PROD-ONLY legacy cleanup — removes dead tables/columns that predate the
-- current architecture so production matches the canonical chain (schema.sql +
-- migrations through 021). Operator-gated, backup-first. NOT a migration and
-- NOT run by migrate.mjs/CI: staging and fresh databases never had this legacy,
-- so it is a no-op there and would only ever apply to production.
--
-- Every item below was verified before writing this file:
--   • the 12 dropped tables are EMPTY (0 rows) and referenced by no current code
--     and no canonical FK; their live successors are the bw_* tables.
--   • the bookings payment columns are legacy — createBooking() writes only the
--     13 canonical columns; live payment data lives in bw_booking_state.
--   • the shop_settings columns are not in SHOP_SETTINGS_PATCH_FIELDS and have
--     no code reads. shop_settings.id is the prod PRIMARY KEY (can't DROP without
--     a full rebuild) so it is intentionally LEFT in place.
--
-- foreign_keys=OFF so dropping legacy tables that reference each other can't trip
-- FK checks (all empty, so nothing cascades). Apply via `wrangler d1 execute
-- --file` (single connection, PRAGMA holds).
PRAGMA foreign_keys=OFF;

-- ── Dead legacy tables (empty, unused; superseded by bw_* equivalents) ──────
DROP TABLE IF EXISTS availability;
DROP TABLE IF EXISTS business_days;
DROP TABLE IF EXISTS booking_items;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS commission_ledger;
DROP TABLE IF EXISTS platform_alerts;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS push_notifications;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS scanner_permissions;
DROP TABLE IF EXISTS monthly_reports;
DROP TABLE IF EXISTS cookie_consents;

-- ── bookings: drop legacy payment columns (data lives in bw_booking_state) ──
ALTER TABLE bookings DROP COLUMN booking_type;
ALTER TABLE bookings DROP COLUMN deposit_amount;
ALTER TABLE bookings DROP COLUMN total_amount;
ALTER TABLE bookings DROP COLUMN stripe_payment_intent_id;
ALTER TABLE bookings DROP COLUMN qr_code_data;
ALTER TABLE bookings DROP COLUMN promo_code;
ALTER TABLE bookings DROP COLUMN promo_discount_percent;
ALTER TABLE bookings DROP COLUMN checked_in_at;
ALTER TABLE bookings DROP COLUMN completed_at;
ALTER TABLE bookings DROP COLUMN updated_at;

-- ── shop_settings: drop dead columns (id PK intentionally kept) ────────────
ALTER TABLE shop_settings DROP COLUMN google_review_url;
ALTER TABLE shop_settings DROP COLUMN created_at;
ALTER TABLE shop_settings DROP COLUMN promo_discount_enabled;
ALTER TABLE shop_settings DROP COLUMN terminal_enabled;
ALTER TABLE shop_settings DROP COLUMN terminal_reader_id;
ALTER TABLE shop_settings DROP COLUMN terminal_reader_label;
ALTER TABLE shop_settings DROP COLUMN usb_scanner_enabled;

-- ── shops: drop dead column ────────────────────────────────────────────────
ALTER TABLE shops DROP COLUMN setup_checklist_json;

PRAGMA foreign_keys=ON;
