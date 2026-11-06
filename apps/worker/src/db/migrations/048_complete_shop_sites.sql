-- Complete generated shops (2026-11).
-- Numbered 048, not 046: 046/047 are reserved by the audit-trail work that is
-- committed on a local main but not yet pushed. The applier tracks applied
-- files by name, so the gap is harmless and either order replays.
-- staff.speciality: an owner-entered specialism shown on the public team
--   section beside the bio. Also added to schema.sql, so a fresh DB built from
--   the snapshot already has it and this ALTER is a benign duplicate.
-- shop_sites.gallery_images_json: JSON array of generated "the space" photo
--   URLs (interior, tools, details), kept apart from the positional
--   per-service catalog so a gallery photo can never land on a service card.
--   shop_sites is migration-only (not in schema.sql), so this ALTER always runs.
ALTER TABLE staff      ADD COLUMN speciality TEXT;
ALTER TABLE shop_sites ADD COLUMN gallery_images_json TEXT;
