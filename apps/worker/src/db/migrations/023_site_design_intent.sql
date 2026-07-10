-- WS-6: persist the per-shop design intent the generation pipeline already
-- produces (research spec) but used to discard. hero_cta and about_title
-- drive template copy; palette_json stores the full 5-colour palette
-- (background/text/muted included) for the future light-theme work — the
-- renderer stays dark until the contrast-guard item ships.
-- trust_signals_json/usps_json/layout_mood/brand_voice already exist (021);
-- the assembler now writes all of them.

ALTER TABLE shop_sites ADD COLUMN hero_cta TEXT;
ALTER TABLE shop_sites ADD COLUMN about_title TEXT;
ALTER TABLE shop_sites ADD COLUMN palette_json TEXT;
