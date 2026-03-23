-- Website visibility: draft (generated, not public), live, paused
ALTER TABLE shop_sites ADD COLUMN website_status TEXT NOT NULL DEFAULT 'draft';

UPDATE shop_sites SET website_status = 'live' WHERE status = 'active';
