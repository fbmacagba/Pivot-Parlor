# Runbook: Bookings table rebuild (`in_progress` status)

**Status:** ready, operator-gated. NOT auto-applied by CI or `migrate.mjs`.
**Why decoupled:** this is the single most destructive operation in the remediation. It must be backup-first and applied deliberately, never folded into a routine migration run.

## The bug

Staff "mark in progress" (`PUT /api/staff/me/bookings/:id/status`, allowed values `in_progress`/`completed`) writes `status='in_progress'`, but the `bookings` CHECK constraint only allows `pending,confirmed,completed,cancelled,no_show`. So the action fails the constraint and returns 500. The status is wired through the UI (staff dashboards render an `in_progress` badge), so it is a real, intended feature that has never worked.

SQLite cannot `ALTER` a CHECK constraint, so the fix requires a table rebuild.

## Key finding: D1 enforces foreign keys

Verified on staging (2026-06-13): inserting a `bw_booking_items` row with a non-existent `booking_id` is rejected with `FOREIGN KEY constraint failed`. Because `bw_booking_state.booking_id`, `bw_booking_items.booking_id`, and `reviews.reviewed_booking_id` reference `bookings(id) ON DELETE CASCADE`, a naive `DROP TABLE bookings` would **cascade-delete every deposit/booking-state/review row**. The rebuild must run with `PRAGMA foreign_keys=OFF`.

## The procedure (validated end-to-end on staging)

The rebuild SQL is [apps/worker/src/db/rebuild-bookings.sql](../../apps/worker/src/db/rebuild-bookings.sql). It changes only the CHECK (adds `in_progress`); all FK definitions are preserved exactly (`shop_id` cascades; `staff_id`/`service_id` stay RESTRICT so removing a staff member or service never wipes booking history). `foreign_keys=OFF` at the top is mandatory and holds across the file because `--file` runs on one connection.

Staging validation result: booking + `bw_booking_state` + `bw_booking_items` child rows all survived the rebuild; `in_progress` was accepted afterward; `idx_bookings_active_slot` was recreated.

### Apply to production

1. **Back up first** (D1 Time Travel gives a bookmark, but take an explicit export too):
   ```bash
   cd apps/worker
   npx wrangler d1 export pivot-parlor-db --remote --output pivot-parlor-db-backup-$(date +%Y%m%d).sql
   ```
2. **Dry-run on staging again** (it is migrated from the same chain):
   ```bash
   npx wrangler d1 execute pivot-parlor-db-staging --remote --file=src/db/rebuild-bookings.sql --yes
   ```
3. **Apply to production** (off-peak — the table is briefly dropped/renamed):
   ```bash
   npx wrangler d1 execute pivot-parlor-db --remote --file=src/db/rebuild-bookings.sql --yes
   ```
4. **Verify:**
   ```bash
   npx wrangler d1 execute pivot-parlor-db --remote --command \
     "UPDATE bookings SET status='in_progress' WHERE id=(SELECT id FROM bookings LIMIT 1); SELECT changes();"
   # and confirm child-row counts are unchanged vs the backup
   ```

`schema.sql` (migration `000`) already carries the `in_progress` CHECK, so **fresh** databases are correct without this script — it is only needed for existing databases (production), which were baselined before the CHECK was added. After running it, prod matches `schema.sql`. There is intentionally no entry in `migrations/` for this, so `migrate.mjs`/CI will never apply it through the non-transactional runner.

## Rollback

Restore from the export taken in step 1 (`wrangler d1 execute --file=<backup>.sql` into a fresh DB, or D1 Time Travel to the pre-change bookmark).
