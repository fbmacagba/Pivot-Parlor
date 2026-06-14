-- Migration 020: shop timezone for schedule/slot calculations.
-- Shop.timezone existed in @repo/types but never in the database; all slot
-- math was UTC-only, so a 09:00 Europe/London schedule produced slots an
-- hour off during BST (late March - late October).
ALTER TABLE shops ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/London';
