-- Migration 003: shop_sites table for AI-generated booking pages

CREATE TABLE IF NOT EXISTS shop_sites (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  template TEXT NOT NULL,
  headline TEXT,
  tagline TEXT,
  about TEXT,
  services_json TEXT,
  color_primary TEXT,
  color_accent TEXT,
  font_heading TEXT,
  font_body TEXT,
  hero_image_url TEXT,
  logo_url TEXT,
  catalog_images_json TEXT,
  generated_at TEXT,
  status TEXT DEFAULT 'active',
  FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_sites_shop_id ON shop_sites(shop_id);
