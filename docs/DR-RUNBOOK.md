# Disaster recovery & data-layer runbook (WS-8)

Operational procedures for the platform's data layer. The commands here are
real and current as of 2026-07-12 (wrangler v4 era; Workers Paid plan).
Run all `wrangler d1` commands from `apps/worker` so wrangler resolves the
account and config.

## 1. What holds state

| Store | Contents | Recovery posture |
|-------|----------|------------------|
| D1 `pivot-parlor-db` | **System of record**: shops, users, bookings, sales, money (`bw_transactions`, `bw_commission_ledger`), inventory, sites | Time Travel PITR + this runbook |
| D1 `pivot-parlor-db-staging` | Staging copy, E2E fixtures | Rebuildable from the migration chain |
| KV | Derived caches: site snapshots (`gen:*`), rate-limit counters, token revocations | Rebuildable; losing it is degradation, not data loss (revocations: re-revoke) |
| R2 | Shop/site images | Source assets; no automated second copy today |
| Queues | In-flight generation jobs | At-least-once delivery; jobs are idempotent, safe to re-enqueue |
| Stripe | Payments ledger of record | Recoverable from Stripe's records independent of D1 |

Money truth lives in two places by design: D1 rows AND Stripe. After any D1
restore, reconcile against Stripe (section 4, step 5).

## 2. Backups: what exists automatically

**D1 Time Travel** keeps 30 days of continuous point-in-time history for every
database on the paid plan. There is nothing to schedule — every write creates
restorable history automatically.

Capture the current restore point (a "bookmark"):

```bash
npx wrangler d1 time-travel info pivot-parlor-db --json
# → { "bookmark": "000000a3-00000000-000050a6-b30c..." }
```

Get a bookmark for a past moment:

```bash
npx wrangler d1 time-travel info pivot-parlor-db --timestamp="2026-07-12T09:00:00+00:00"
```

`scripts/migrate.mjs` captures a bookmark automatically before every `--remote`
run and prints it; on failure it prints the exact restore command.

**Rule (Definition of Done, sign-off lane):** before any migration that
mutates production data (as opposed to pure additive DDL), capture a bookmark
AND take a cold export (section 3).

## 3. Cold exports (off-platform copy)

Time Travel history lives inside Cloudflare and expires after 30 days. For a
copy that survives both, export to a local `.sql` file:

```bash
npx wrangler d1 export pivot-parlor-db --remote --output=../../backups/prod-$(date +%Y%m%d).sql
```

Useful variants: `--no-data` (schema only), `--table <name>` (specific tables).

- Exports contain **customer PII and money rows**. Never commit them; the
  repo's `backups/` path is gitignored — verify before creating it elsewhere.
- Cadence: before every sign-off-lane data migration, and monthly otherwise.
  (Automating a scheduled export to R2 is deliberately NOT done: a same-account
  R2 copy dies with the account, which is the scenario cold exports exist for.)

## 4. Restore procedure (production)

Time Travel restore is **destructive and in-place**: it rewinds the whole
database, cancels in-flight queries, and **discards every write made after the
restore point** — including legitimate customer bookings and payments that
landed after the incident. On a live database, forward-fixing is usually the
better call; restore when the schema/data damage is worse than losing the
interim writes.

1. **Stop the bleeding.** If a bad deploy is writing garbage, roll back the
   worker deploy first (`gh` revert PR / `npx wrangler rollback`), so the
   restored database isn't immediately re-corrupted.
2. **Capture NOW as an undo point** — restoring is itself undoable only if you
   have the pre-restore bookmark:
   ```bash
   npx wrangler d1 time-travel info pivot-parlor-db --json
   ```
3. **Restore** to the incident's pre-damage point (bookmark from the migration
   log, `migrate.mjs` output, or a timestamp):
   ```bash
   npx wrangler d1 time-travel restore pivot-parlor-db --bookmark=<BOOKMARK>
   # or: --timestamp="2026-07-12T09:00:00+00:00"
   ```
   The command prints a new bookmark for undoing the restore.
4. **Reconcile migration state.** If the restore rewound past a migration,
   `schema_migrations` now disagrees with reality — run
   `node scripts/migrate.mjs --remote` and review what it lists as pending
   before letting CI deploy anything.
5. **Reconcile money.** Compare `bw_transactions` / `bw_commission_ledger`
   against the Stripe dashboard (Ferdinand sandbox in test mode) for the
   window between the restore point and the incident; re-book missing rows via
   the normal webhook replay (Stripe → resend events) rather than hand-editing.
6. **Verify:** `npm run verify:live` and a manual booking walkthrough.

## 5. Migration-failure recovery

`migrate.mjs` (WS-8 behaviour):

- Prints a Time Travel bookmark before applying anything remotely.
- Applies statement-by-statement (D1 has no cross-statement transactions from
  the CLI), so a mid-file failure leaves the file **half-applied and
  unrecorded**.
- Migrations numbered **> 042** apply strictly on tracked databases: a
  "duplicate column name" / "already exists" error is treated as schema drift
  and aborts. (On fresh replays the snapshot overlap makes those benign, and
  they're skipped as before.)

When a remote run fails:

1. Read the failing statement from the log. Decide forward-fix vs restore
   (section 4's warning applies).
2. **Forward-fix path:** correct the migration file or the database shape,
   re-run `node scripts/migrate.mjs --remote`. If the file half-applied, the
   re-run replays it from the top; for a >042 file the strict check will stop
   on the already-applied statements — verify each statement's effect exists
   (`PRAGMA table_info`), then record it applied:
   ```sql
   INSERT INTO schema_migrations (name) VALUES ('0NN_name');
   ```
3. **Restore path:** use the bookmark the run printed, then section 4 from
   step 2.

## 6. Staging restore drill

Rehearse on staging before ever needing it in anger (roughly quarterly):

1. `npx wrangler d1 time-travel info pivot-parlor-db-staging --json` — note bookmark A.
2. Write a marker row; capture bookmark B.
3. Restore to A; confirm the marker is gone.
4. Restore to B; confirm the marker is back (undo works).
5. Run the staging E2E suite.

## 7. Scaling model decision (WS-8, decided 2026-07-12)

**Decision: stay on a single shared D1 database.** Revisit only when a trigger
below fires.

Rationale: current data volume is a rounding error against D1's 10 GB per-DB
limit; every tenant query is already shop-scoped (`WHERE shop_id = ?`); the
two unbounded cron fan-outs were bounded in PR #54; and a single DB keeps the
migration chain, tests, and DR story simple.

Triggers to revisit (any one):

- Database size crosses **5 GB** (`wrangler d1 info pivot-parlor-db`).
- Sustained write contention: booking/slot-claim p95 latency degrades under
  load (D1 is effectively single-writer per database).
- A tenant requires data isolation for compliance reasons.

Options at that point, in preference order:

1. **Durable Object per shop for hot booking state** (slot claims, walk-in
   queue): keeps D1 as the system of record, moves the contended writes to
   per-shop serialized state. Smallest blast radius.
2. **Per-tenant D1 databases** sharded by `shop_id`: natural key, but requires
   a binding/routing layer, per-tenant migrations, and a per-tenant DR story —
   only worth it at real multi-tenant scale.
3. **D1 read replicas / Sessions API** if the pressure is read-side only.

## 8. Related

- Migration mechanics and replay-guard directive: `CLAUDE.md` → Database migrations.
- Bounded cron sweeps (reminder, deposit): `apps/worker/src/services/reminder.ts`,
  `apps/workers/booking/src/services/deposit-sweep.ts`.
- Schema assertions (fail-loudly on missing migrations):
  `apps/workers/booking/src/db/ensure-schema.ts`, `apps/workers/chatbot/src/ensure-schema.ts`.
