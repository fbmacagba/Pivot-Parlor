-- Migration 017: Google Business Profile link per shop
ALTER TABLE shop_settings ADD COLUMN google_business_url TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_settings ADD COLUMN show_google_business INTEGER NOT NULL DEFAULT 0;
