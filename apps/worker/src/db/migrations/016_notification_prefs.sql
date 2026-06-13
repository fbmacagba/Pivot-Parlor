-- Migration 016: notification preferences on shop_settings
--
-- shop_settings was historically created at runtime by the booking worker's
-- ensure-schema (never by a migration), so a fresh replay of this chain broke
-- here. The CREATE below makes the chain self-sufficient; on databases where
-- the table already exists it is a no-op (IF NOT EXISTS). Existing databases
-- adopting migration tracking are baselined and never re-run this file.
CREATE TABLE IF NOT EXISTS shop_settings (
  shop_id TEXT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  instagram_url TEXT DEFAULT '',
  show_instagram INTEGER NOT NULL DEFAULT 0,
  facebook_url TEXT DEFAULT '',
  show_facebook INTEGER NOT NULL DEFAULT 0,
  tiktok_url TEXT DEFAULT '',
  show_tiktok INTEGER NOT NULL DEFAULT 0,
  twitter_url TEXT DEFAULT '',
  show_twitter INTEGER NOT NULL DEFAULT 0,
  youtube_url TEXT DEFAULT '',
  show_youtube INTEGER NOT NULL DEFAULT 0,
  whatsapp_url TEXT DEFAULT '',
  show_whatsapp INTEGER NOT NULL DEFAULT 0,
  linkedin_url TEXT DEFAULT '',
  show_linkedin INTEGER NOT NULL DEFAULT 0,
  commission_bearer TEXT NOT NULL DEFAULT 'shop',
  product_commission_enabled INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE shop_settings ADD COLUMN booking_confirmation_email INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shop_settings ADD COLUMN booking_reminder_email INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shop_settings ADD COLUMN reminder_hours_before INTEGER NOT NULL DEFAULT 24;
ALTER TABLE shop_settings ADD COLUMN review_request_email INTEGER NOT NULL DEFAULT 1;
