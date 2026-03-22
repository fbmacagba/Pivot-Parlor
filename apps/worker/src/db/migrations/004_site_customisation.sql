-- Migration 004: owner customisation fields on shop_sites

ALTER TABLE shop_sites ADD COLUMN design_notes TEXT;
ALTER TABLE shop_sites ADD COLUMN owner_color_primary TEXT;
ALTER TABLE shop_sites ADD COLUMN owner_color_accent TEXT;
