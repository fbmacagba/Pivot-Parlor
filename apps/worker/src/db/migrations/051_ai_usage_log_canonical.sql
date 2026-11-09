-- Migration 051: rebuild ai_usage_log to the shape the chain defines.
--
-- Production's ai_usage_log predates migration 019, which was baselined there
-- (recorded, never run), so the table kept its original definition:
--   usage_type TEXT NOT NULL CHECK(usage_type IN ('research','image','chatbot','site_build'))
-- The chain (019 + 050) has no such CHECK. Every site-pipeline cost row
-- (usage_type site_research, site_text, site_image_*) was therefore refused
-- in production, so the cost log never wrote a row there (read from
-- sqlite_master in the D1 console, 2026-11-09).
--
-- SQLite cannot drop a CHECK in place, so the table is rebuilt: create the
-- canonical table, copy every row, drop the old one, rename. On a database
-- built from the chain this changes nothing.
--
-- scripts/migrate.mjs runs a file statement by statement, NOT atomically:
--   - fails at the CREATE or the copy: the old table is untouched (drop
--     ai_usage_log_new, then re-run)
--   - fails at the RENAME: the rows are in ai_usage_log_new (rename it by hand)
-- The pre-run Time Travel bookmark covers both.
--
-- The copy keeps shop_id only when the shop still exists (the table's own
-- ON DELETE SET NULL semantics), so a stray row cannot fail the foreign key.

CREATE TABLE ai_usage_log_new (
  id TEXT PRIMARY KEY,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  worker_name TEXT NOT NULL,
  model TEXT NOT NULL,
  usage_type TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cost_basis TEXT
);

INSERT INTO ai_usage_log_new
  (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, job_id, created_at, cost_basis)
SELECT
  u.id,
  (SELECT s.id FROM shops s WHERE s.id = u.shop_id),
  u.worker_name, u.model, u.usage_type, u.input_tokens, u.output_tokens, u.total_tokens,
  u.estimated_cost_usd, u.job_id, u.created_at, u.cost_basis
FROM ai_usage_log u;

DROP TABLE ai_usage_log;

ALTER TABLE ai_usage_log_new RENAME TO ai_usage_log;
