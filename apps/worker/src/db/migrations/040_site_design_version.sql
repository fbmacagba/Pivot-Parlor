-- Migration 040 (WS-6 item 3): design_version gate for palette-driven theming.
-- Version 1 = pre-token sites: the web renders them with the exact legacy
-- dark styling. Version 2 (stamped by the builder on every new assembly) =
-- palette_json drives the page background/ink/accent tokens (light themes)
-- and the seeded per-shop variation tokens. Existing sites therefore keep
-- their current look until they are regenerated.
ALTER TABLE shop_sites ADD COLUMN design_version INTEGER NOT NULL DEFAULT 1;
