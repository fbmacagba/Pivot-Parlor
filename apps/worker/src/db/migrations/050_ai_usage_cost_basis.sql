-- AI cost log: how each row's estimated_cost_usd was worked out, so a cost of
-- 0 is never mistaken for "free" (packages/llm/src/usage.ts):
--   'live'    priced from the OpenRouter feed (the API's served model list)
--   'catalog' the same list's snapshot fallback price
--   NULL      no price known, or a row written before this column or by the
--             chatbot's flat per-token estimate
-- ai_usage_log is migration-only (019, not in schema.sql), so this ALTER
-- always runs.
ALTER TABLE ai_usage_log ADD COLUMN cost_basis TEXT;
