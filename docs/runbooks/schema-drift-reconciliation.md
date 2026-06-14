# Runbook: Schema drift reconciliation (2026-06-14)

**Status:** ✅ DONE. Production schema now matches the canonical chain (schema.sql + migrations through 021) exactly, except one intentionally-retained column (`shop_settings.id`, see below).

## What the drift was

Production had accumulated runtime DDL (from background workers and an older architecture) that the migration chain never described. Three categories:

1. **Live but uncanonicalized** — real schema the current code uses, only ever created at runtime:
   - `shop_sites`: `seo_title, seo_description` (builder worker), `trust_signals_json, usps_json, layout_mood, brand_voice` (research/audit).
   - `shop_settings`: `phone, lat, lng` — written by the settings PATCH (`SHOP_SETTINGS_PATCH_FIELDS`); a fresh DB would have errored on that PATCH.
   - `shop_pages` table — read by the audit worker (`SELECT * FROM shop_pages`); had live rows on prod.
2. **Canonical, prod hadn't materialized** — 019 items skipped because prod was baselined and the booking worker hadn't run: 7 `bw_*` tables, `services.service_type`, `shops.operational_status`.
3. **Legacy / dead** — superseded by the `bw_*` architecture, no current code use, all empty (or empty table for columns): 12 tables + the `bookings` payment columns + 7 `shop_settings` columns + `shops.setup_checklist_json`.

## What was done

- **Migration `021_canonicalize_site_generation.sql`** (additive, in the chain): adds the category-1 columns and `shop_pages`. Benign no-ops on prod; real on staging/fresh. Applied + recorded on staging and prod.
- **Materialized 019 on prod** (category 2): re-ran 019's idempotent DDL on prod (`CREATE TABLE IF NOT EXISTS bw_*`, `ADD COLUMN service_type/operational_status`) — identical to the booking worker's `ensure-schema`, so zero conflict.
- **`cleanup-legacy-prod.sql`** (category 3, prod-only, backup-first): dropped the 12 dead tables, the 10 legacy `bookings` payment columns (data lives in `bw_booking_state`), 7 dead `shop_settings` columns, and `shops.setup_checklist_json`. Validated against the prod backup (0 failures) before applying.

### `shop_settings.id` — intentionally kept
Prod's `shop_settings` PRIMARY KEY is `id` (canonical uses `shop_id`, which is `UNIQUE` on prod so queries behave identically). Dropping `id` needs a full table rebuild of a live, FK-referenced table — not worth the risk for a cosmetic difference. Left in place. This is the only remaining prod↔canonical difference.

## Verification
- Harness 76/76 green with 021 (chain replayable).
- Cleanup validated against the prod backup in `node:sqlite` (0 failures) before prod.
- Post-apply prod↔canonical diff: 27 tables = 27, no table drift, no column drift except `shop_settings.id`.
- `npm run verify:live` 9/9 after the change.

## Do NOT re-run
`cleanup-legacy-prod.sql` is **prod-only and already applied**. Staging/fresh DBs never had this legacy, so it would error there (dropping non-existent columns). It is intentionally not a migration and not run by `migrate.mjs`/CI.

## Backups
`pivot-parlor-db-backup-20260614-pre-cleanup.sql` (gitignored) was taken immediately before the cleanup; D1 Time Travel also covers the window.
