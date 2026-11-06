-- Owner review for regenerated public sites (2026-11).
-- A regeneration of a site that is already public (website_status 'live' or
-- 'paused') is stored here instead of overwriting shop_sites, so the owner or
-- a developer can preview it and choose Publish or Discard. A draft site has
-- no public version, so the assembler still writes it directly.
-- One candidate per shop: a newer regeneration replaces it (no timers).
-- payload_json: {"version":1,"columns":{...shop_sites values...},
--   "owner_palette":{"primary","accent"}|null,"service_names":[...]}.
-- Also in schema.sql, so a database built from the snapshot already has it and
-- this file is a no-op there.
CREATE TABLE IF NOT EXISTS shop_site_candidates (
  shop_id      TEXT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  job_id       TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
