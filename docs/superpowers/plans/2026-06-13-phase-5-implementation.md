# Phase 5 Implementation Plan — Environments & Migration Discipline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tracked, replayable migrations applied by CI; a real staging environment (separate D1/KV/R2/queues); Playwright physically unable to default to production.

**Architecture:** Branch `remediation/phase-5` stacked on `remediation/phase-4`. New `scripts/migrate.mjs` (shells out to wrangler, tracks in `schema_migrations`); migration 019 absorbs all runtime DDL from the booking/chatbot workers' ensure-schema; `[env.staging]` in worker wrangler.toml backed by freshly-created staging resources.

**Schema-ownership survey (canonical going forward = main worker migrations):**
- `shop_settings` base def + `bw_availability`, `bw_business_days`, `bw_booking_items`, `bw_transactions`, `bw_commission_ledger`, `bw_platform_alerts`, `bw_booking_state` + ALTERs on `shops` (setup_completed, stripe_connect_onboarded, stripe_connect_account_id, operational_status), `shop_settings` (address, hours_json, sells_products, promo_discount_code, promo_discount_percent), `services.service_type` — from `apps/workers/booking/src/db/ensure-schema.ts`
- `chat_sessions`, `ai_usage_log`, `shop_settings.promo_active` — from `apps/workers/chatbot/src/ensure-schema.ts`
- Migrations 016/017 ALTER `shop_settings` before anything creates it → fresh replay breaks at 016.

### Task 1: Replayable migration chain (T5.3)

- [ ] Prepend `CREATE TABLE IF NOT EXISTS shop_settings (…base def from booking ensure-schema…)` to `016_notification_prefs.sql`. Editing history is safe: no tracking table exists anywhere yet, and production gets baselined (Task 2), never re-runs 016.
- [ ] New `019_absorb_runtime_ddl.sql`: everything in the survey above as `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`. Production already has all of it (workers created it at runtime) — covered by baseline.
- [ ] Keep the workers' ensure-schema files as defensive idempotent duplicates (removing them mid-rollout risks ordering breakage); add a header comment marking migrations as canonical. Revisit removal after staging soak.

### Task 2: Tracking + migrate script (T5.1)

- [ ] `scripts/migrate.mjs`: `node scripts/migrate.mjs [--remote] [--db <name>] [--config <wrangler.toml>] [--baseline] [--dry-run]`
  - Ensures `schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT)`.
  - Migration list = `000_schema` (schema.sql) + sorted `migrations/*.sql`.
  - `--baseline`: record all as applied WITHOUT executing (one-time adoption for prod).
  - Safety: refuses to replay onto a database that has tables but no migration history (instructs `--baseline`).
  - Applies pending in order via `wrangler d1 execute --file`, records each.
- [ ] Validate: fresh `--local` replay end-to-end; baseline flow; second run = no-op.
- [ ] Make the vitest harness apply migrations STRICTLY (drop the try/catch) — every test run now proves replayability.

### Task 3: CI applies migrations (T5.2)

- [ ] `deploy-worker.yml`: replace the schema.sql-only step with `node scripts/migrate.mjs --remote`.
- [ ] **Operator action (one-time, before first post-merge deploy):** `node scripts/migrate.mjs --remote --baseline` against prod.

### Task 4: Staging environment (T5.4)

- [ ] Create: D1 `pivot-parlor-db-staging`, KV namespace, R2 `pivot-parlor-assets-staging`, queues `pivot-parlor-reminders-staging` + `site-research-queue-staging` (additive; zero prod impact).
- [ ] `[env.staging]` in `apps/worker/wrangler.toml`: name `pivot-parlor-api-staging`, staging bindings, `ENVIRONMENT="staging"`, `E2E_FIXTURES="true"`.
- [ ] Set staging-only `JWT_SECRET` (random), deploy staging worker, run full migration replay against staging (real-world validation of Task 1-2), seed dev account.
- [ ] Web staging: document Pages preview-branch deploy (`--branch=staging`) + per-environment `API_URL`; full automation deferred until E2E-in-CI (noted, not silent).

### Task 5: E2E safety (T5.5) + docs (T5.6)

- [ ] `playwright.config.ts`: throw with a clear message when `E2E_BASE_URL` is unset — no production default, ever. Update `.env.example`.
- [ ] CLAUDE.md: migration count/runbook (new-migration procedure, baseline note, staging commands), test commands, staging section. README deployment section updated.

### Task 6: Verify + ship

- [ ] Suite green (strict harness), tsc 0, build green, fresh local replay green, staging worker deployed + migrated; commit per task; stacked PR base `remediation/phase-4`.

## Self-review
T5.1✓(2) T5.2✓(3) T5.3✓(1) T5.4✓(4) T5.5✓(5) T5.6✓(5). Deviation from master list documented: ensure-schema demoted to "defensive duplicate" not "no-op" (rollout safety). Web staging automation explicitly deferred, not skipped silently.
