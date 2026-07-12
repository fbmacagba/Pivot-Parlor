-- Migration 042 (WS-6 item 5): curated typography. The research pipeline has
-- always generated heading_weight ("400".."900") and heading_style
-- (serif/sans-serif) and then dropped them; the builder now persists both.
-- The web honours heading_weight only on design_version >= 2 sites and uses
-- heading_style as the serif/sans hint when resolving legacy font names onto
-- the curated self-hosted set. NULL on existing rows = rendering unchanged.
ALTER TABLE shop_sites ADD COLUMN heading_weight TEXT;
ALTER TABLE shop_sites ADD COLUMN heading_style TEXT;
