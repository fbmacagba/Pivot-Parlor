-- Visual Editor (2026-07): per-service custom photo + hero/logo lock flags.
-- services.image_url: a service's own image (keyed by service id); NULL falls
--   back to the AI catalog pool. Also added to schema.sql, so a fresh DB built
--   from the snapshot already has it and this ALTER is a benign duplicate.
-- shop_sites.locked_images_json: {"hero":true,"logo":true}-style flags marking a
--   custom hero/logo the assembler must preserve across a full regenerate.
--   shop_sites is migration-only (not in schema.sql), so this ALTER always runs.
ALTER TABLE services   ADD COLUMN image_url TEXT;
ALTER TABLE shop_sites ADD COLUMN locked_images_json TEXT;
