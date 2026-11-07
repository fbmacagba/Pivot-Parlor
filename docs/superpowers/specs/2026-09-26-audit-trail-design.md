# Audit trail: logged, persistent and auditable activity

**Status:** approved section by section in brainstorming on 2026-09-26; written spec awaiting owner review.
**Owner:** platform operator (developer role). Shop-owner access is stage 2.
**Origin:** owner requirement "All activities must be logged, persistent and auditable"
(2026-09-26), and the open **Med** finding "No audit log" in `docs/AUDIT-2026-07-06.md`
(line 197).

## 1. Goal

Every activity on the platform that changes something, every AI call, and every read of
personal data that matters for GDPR leaves an entry that:

- is written **in the same all-or-nothing step** as the change it describes, so nothing
  happens unlogged;
- is **append-only**: the app never edits or deletes an entry except the two narrow cases
  in section 6;
- is **tamper-evident**: entries are hash-chained, archived to a retention-locked R2 bucket,
  and anchored daily outside Cloudflare, so any rewrite is detectable;
- is **kept 6 years**, with personal details blanked 30 days after a shop leaves or a person
  asks to be erased;
- can be **searched, checked and exported** by the platform operator.

### 1.1 Staging (decided during brainstorming, do not re-ask)

The full requirement splits into four stages. This spec covers **stages 1 and 4 together**:

| Stage | Scope | This spec |
|---|---|---|
| 1 | Core trail, recording helper, operator viewer | yes |
| 2 | Shop-owner view of their own shop's entries | no (reuses this design) |
| 3 | Security events: logins, failed logins, OAuth, role changes, denials, alerting | no |
| 4 | Tamper evidence, retention, blanking, dispute and subject-access exports | yes |

The table is shaped so stages 2 and 3 add rows and a filtered view, never a redesign.

### 1.2 Decisions taken during brainstorming (do not re-ask)

- **Readers:** the platform operator, shop owners (stage 2), disputes/compliance, and
  security monitoring (stage 3).
- **Retention:** 6 years per entry (UK tax-record length). Names, emails and IP addresses
  are replaced by an anonymous reference 30 days after a shop leaves or a person's erasure
  request, matching the DPA's 30-day deletion grace. The chain stays valid.
- **Coverage:** changes + every AI call + sensitive reads (viewing a customer record, any
  export, opening the audit viewer). Ordinary page views are not recorded.
- **On failure: refuse the action.** A database change and its entry share one D1 batch;
  any other action writes a "started" entry first and is refused if that write fails.
- **Approach A:** record in the change's batch, seal every minute, archive to a locked
  R2 bucket. (Rejected: a single Durable Object writer, which cannot join the change's
  D1 batch; Cloudflare Analytics Engine / Logpush, which are not transactional, keep data
  about 3 months and cannot be chained.)

## 2. Facts the design rests on

Verified 2026-09-26 by reading the code or Cloudflare's docs, unless marked otherwise.

- Every worker binds the same D1 database `pivot-parlor-db` (API worker, research, text,
  chatbot, booking, builder, images, audit). One table serves all of them.
- Existing records: `ai_usage_log` (written by the chatbot, research and text workers; **not**
  by AI Deploy theme generation) and `processed_stripe_events` (webhook dedupe). Nothing
  records site pause/activate, theme apply, refunds, price edits, deletes, logins or role
  changes.
- The API worker already has cron triggers (`0 3`, `0 8`, `0 20` UTC) and a retention sweep
  at 03:00 (`apps/worker/src/services/retention.ts`, LEG-6).
- The latest migration is `045_visual_editor.sql`; the next is `046`. (CLAUDE.md still says
  "up to 042"; fix that line in the same change.)
- `research`, `text`, `chatbot` and `booking` are npm workspaces and can import a shared
  package (precedent: `@repo/llm`). `builder`, `images` and `audit` are **not** yet.
- **R2 bucket locks** exist (`npx wrangler r2 bucket lock add <bucket> --name <n>
  --retention-days <d>`): objects under a rule cannot be deleted or overwritten while the
  rule applies. **A lock rule can be explicitly removed** by someone with account access,
  so the lock alone does not defend against a compromised Cloudflare account; section 5.4
  adds an anchor outside Cloudflare for that.
- **A D1 batch is one transaction.** Cloudflare's `batch()` reference: "Batched statements
  are SQL transactions. If a statement in the sequence fails, then an error is returned for
  that specific statement, and it aborts or rolls back the entire sequence." Section 4.4
  depends on this.
- **Both SQL splitters break triggers.** `scripts/migrate.mjs` (line ~132) and
  `apps/worker/test/apply-schema.ts` (line ~27) split migration files on every `;`. A
  trigger body (`BEGIN ... ; END;`) would be cut in half. Plan task 1 fixes both.
- **Not yet verified:** that D1 accepts `CREATE TRIGGER` with `RAISE(ABORT, ...)`. Cloudflare's
  docs search did not confirm or deny it. Plan task 1 proves it on the local simulator and on
  the staging database before anything else depends on it; section 6.1 gives the fallback.

## 3. Data model (migration 046)

### 3.1 `audit_log`

One row per activity.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | `crypto.randomUUID()` |
| `occurred_at` | TEXT | ISO-8601 UTC, set by the helper |
| `seq` | INTEGER NULL UNIQUE | order number, set once by the sealer |
| `sealed_at` | TEXT NULL | set once by the sealer |
| `archived_at` | TEXT NULL | set once, after the R2 write succeeds |
| `entry_hash` | TEXT | SHA-256 hex over the canonical entry (section 4.2) |
| `chain_hash` | TEXT NULL | SHA-256 hex of `prev_chain_hash || entry_hash`, set by the sealer |
| `actor_type` | TEXT | `developer`, `admin`, `staff`, `customer`, `system`, `anonymous` |
| `actor_ref` | TEXT NULL | FK to `audit_subjects.id`; never an email directly |
| `actor_role` | TEXT NULL | role at the time of the action |
| `via` | TEXT | `dashboard`, `api`, `cron`, `queue`, `webhook` |
| `action` | TEXT | from the fixed catalogue (section 3.3) |
| `phase` | TEXT | `done` for batched changes; `started` / `outcome` for two-step actions |
| `outcome` | TEXT | `succeeded`, `refused`, `failed`, `unknown` |
| `reason` | TEXT NULL | short error or refusal reason |
| `shop_id` | TEXT NULL | empty for platform-wide actions |
| `entity_type` | TEXT NULL | e.g. `shop_site`, `booking`, `service` |
| `entity_id` | TEXT NULL | |
| `changes_json` | TEXT NULL | `{field: [before, after]}` for changed fields only |
| `details_json` | TEXT NULL | action-specific: for `ai.call` the model, route, input/output tokens and estimated cost |
| `request_id` | TEXT NULL | from the request, or the queue job id |
| `parent_id` | TEXT NULL | links an `outcome` row to its `started` row |
| `worker` | TEXT | e.g. `pivot-parlor-api`, `pivot-parlor-research` |
| `ip_ref` | TEXT NULL | FK to `audit_subjects.id` |
| `historical` | INTEGER DEFAULT 0 | 1 for the one-off import of old `ai_usage_log` rows (section 9) |

Indexes: `(shop_id, occurred_at)`, `(actor_ref, occurred_at)`, `(action, occurred_at)`,
`(seq)`, partial index on `sealed_at IS NULL`, partial index on `archived_at IS NULL`.

**Never stored anywhere in the entry:** passwords, password hashes, tokens, session ids,
API keys, card data, full request bodies. `changes_json` carries only an allow-listed set of
fields per entity (section 4.3).

### 3.2 `audit_subjects`

The personal details that entries point at. The only table the blanking job touches, and
**no hash covers it**, so blanking can never break the chain.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | stable anonymous reference, e.g. `subj_<uuid>` |
| `kind` | TEXT | `user`, `visitor_ip` |
| `user_id` | TEXT NULL | the platform user, when known |
| `shop_id` | TEXT NULL | owning shop, for blanking on shop exit |
| `display_name` | TEXT NULL | blanked to NULL |
| `email` | TEXT NULL | blanked to NULL |
| `ip` | TEXT NULL | blanked to NULL |
| `redacted_at` | TEXT NULL | set when blanked |
| `redact_after` | TEXT NULL | when blanking is due (exit or erasure date + 30 days) |

One subject row per user (reused across entries) and per distinct visitor IP per day.

### 3.3 Action catalogue

A fixed, typed list in `@repo/audit` (a TypeScript string-literal union plus a runtime set).
Unknown actions fail type-checking and are rejected at runtime. Initial groups:

- `site.*`: `activate`, `pause`, `regenerate.request`, `regenerate.complete`, `edit`
- `theme.*`: `generate`, `apply`, `compare`
- `shop.*`: `create`, `update`, `delete`, `settings.update`
- `service.*`, `staff.*`, `schedule.*`, `product.*`: `create`, `update`, `delete`
- `booking.*`: `create`, `update`, `cancel`, `status`
- `walkin.*`: `join`, `serve`, `remove`
- `pos.*` / `payment.*`: `sale`, `refund.issue`, `payout`, `stripe.webhook`
- `customer.view`, `data.export`, `audit.view`, `audit.export`, `audit.verify`
- `ai.call` (every LLM or image call, any worker)
- `ai.chatbot_model.set`, `ai.registry.refresh`
- `subject.redact`, `audit.expire`, `audit.seal.alert`

Stage 3 adds `auth.*` actions; stage 2 needs none.

## 4. Recording

### 4.1 `@repo/audit` package

A new workspace package beside `@repo/llm`. It has no I/O of its own, so every caller
controls when and how the write happens.

```ts
// Returns a prepared statement plus any subject upserts; the caller adds them to its batch.
auditStatements(db, entry: AuditEntryInput): D1PreparedStatement[]

// Two-step helpers for actions that are not a single D1 change.
auditStart(db, entry): Promise<{ id: string }>      // throws AuditWriteError on failure
auditOutcome(db, startedId, outcome): Promise<void> // best effort after the fact; see 4.4
```

`AuditEntryInput` requires `action`, `outcome` (or `phase: "started"`), `actor`, `via` and
`worker`; `shop_id`, entity, changes and details are optional per action.

### 4.2 Canonical entry and `entry_hash`

`entry_hash = SHA-256(canonical JSON of every audit_log column except seq, sealed_at,
archived_at, entry_hash, chain_hash)`, with keys sorted and no whitespace. `actor_ref` and
`ip_ref` are hashed as the **reference**, never the personal value, which is why blanking
`audit_subjects` is safe. Computed with `crypto.subtle.digest` in the helper.

### 4.3 Changed-field allow-lists

Each `entity_type` declares which fields may appear in `changes_json` (e.g. `service`: name,
price_pence, duration, active; `shop_site`: website_status, template, headline). Anything
off the list is dropped, so a new column can never leak a secret into the trail.

### 4.4 The refuse-on-failure rule

- **Database changes** (refunds, price edits, pause/activate, deletes, bookings): the route
  sends its own statements and `auditStatements(...)` in **one `db.batch([...])`**. D1 runs
  a batch as one transaction, so the change and its entry commit together or not at all.
  Routes that currently make several separate writes for one action are converted to a
  single batch in this work.
- **Two-step actions** (AI calls, R2/KV writes, emails, Stripe API calls): `auditStart`
  writes a `started` row first; if it throws, the route returns `503` with
  `{ success: false, error: "Could not record this action; nothing was changed." }` and the
  action does not run. After the action, `auditOutcome` writes an `outcome` row
  (`succeeded` or `failed`, plus model, tokens and cost for `ai.call`). If the outcome write
  itself fails, it is retried once; after that the `started` row remains without an outcome
  and the sealer marks it (section 5.1).
- **Sensitive reads**: the entry is written before the data is returned; a failed write
  means the data is not returned (same `503`).

### 4.5 Where it plugs in

- **API worker (Hono):** a middleware sets `c.var.audit` with the actor (from
  `authMiddleware`), `via`, `request_id` and IP. Each route supplies only action, entity and
  changes. `ai-generator.ts` `persistShopTheme` and `generateShopTheme` gain `theme.apply` and
  `ai.call` entries (closing the gap found on 2026-09-25).
- **Background workers:** research, text, chatbot, booking, builder, images, audit use the
  same helper with `actor_type = system`, `via = queue` and the job id as `request_id`. The
  API worker adds `origin_actor_ref` to every queue payload it sends, so a regeneration's
  worker entries record who clicked the button (in `details_json.origin_actor_ref`).
  `builder`, `images` and `audit` become npm workspaces first (same conversion as
  research/text/chatbot in the LLM work).
- **Public visitors:** bookings and chatbot messages record `actor_type = anonymous` with
  an IP subject. Each chatbot reply is an `ai.call` entry.
- **Stripe webhooks:** `payment.stripe.webhook` with `actor_type = system`, `via = webhook`,
  written in the same batch as the webhook's own state change.
- **Cron jobs:** each scheduled run that changes data records its action with
  `actor_type = system`, `via = cron`.

### 4.6 Coverage guarantee

A test enumerates every route registered on the Hono app (and its sub-apps, including
`stripeWebhookApp`) with method `POST`, `PUT`, `PATCH` or `DELETE`, and every queue consumer
and cron branch, and fails if any has no declared audit action in a single registry
(`apps/worker/src/audit/registry.ts`). A route may declare `exempt` only with a written
reason (e.g. a pure proxy whose downstream route audits). Existing routes are covered from
day one; this test is what turns "all activities" from a policy into a build rule.

## 5. Sealing, archiving and checking

### 5.1 Sealer (every minute)

A new cron `* * * * *` on the API worker (production and staging):

1. Take a lease: `UPDATE audit_seal_state SET holder = ?, until = ? WHERE id = 1 AND
   (until IS NULL OR until < ?)`. No row changed means another run holds it: exit.
2. Read the last `chain_hash` (highest `seq`), or a fixed genesis value for the first run.
3. Select up to 500 rows `WHERE sealed_at IS NULL ORDER BY occurred_at, id`, recompute each
   `entry_hash` (a mismatch at this point is a tamper alert, and that row is not sealed),
   assign consecutive `seq`, compute `chain_hash`, and write them in one batch.
   `seq` is the order of **sealing**, not of occurrence: workers' clocks differ slightly and a
   row can commit after a later-stamped one was sealed, so it simply gets a later `seq`. The
   viewer sorts by `occurred_at`; the chain is walked by `seq`.
4. Mark `started` rows older than 15 minutes with no `outcome` child by sealing a
   system-written `outcome` row with `outcome = unknown` linked by `parent_id`, so a crash
   shows as a gap, not as silence.
5. Archive (5.2), then release the lease.

### 5.2 Archive

- New R2 bucket `pivot-parlor-audit` (staging: `pivot-parlor-audit-staging`), bound to the
  API worker as `AUDIT_ARCHIVE`.
- Each sealed batch is written as `YYYY/MM/DD/<first_seq>-<last_seq>.jsonl`: one line per
  entry (no `audit_subjects` data). Each line records an `archive_format` number and holds
  exactly that format's fixed column list (`ARCHIVE_COLUMNS` in `@repo/audit`; format 1 is
  every `audit_log` column except `archived_at` and `archive_key`). A later `audit_log`
  column means a new format; lines already archived keep verifying against the list they
  name (plan Ruling 58).
- `archived_at` is set only after `put` succeeds. The next run re-archives any sealed but
  unarchived rows first. Object names are deterministic, so a retry after a partial failure
  is idempotent.
- Bucket lock rule `retain-6y`, `--retention-days 2192`, over the whole bucket, added by the
  operator during rollout (section 9).

### 5.3 Nightly check

Runs in the existing 03:00 cron, after the retention sweep:

- recompute every `entry_hash` and walk the chain for entries sealed since the last
  successful check (and a full walk every Sunday);
- compare each archived batch file with the database rows;
- record the result as an `audit.verify` entry (ranges checked, pass or fail, first bad seq);
- send an alert email to the operator (existing Resend integration) on any mismatch, on
  entries unsealed for more than 10 minutes, on unarchived sealed rows older than 1 hour, and
  on `unknown` outcomes.

The viewer's "Check now" runs the same check over the range on screen.

### 5.4 Daily anchor outside Cloudflare

Because an R2 lock rule can be removed by an account admin (section 2), the last `chain_hash`
of each UTC day is also written to `anchors/YYYY-MM-DD.json` in the bucket **and emailed to
the operator's address**. The mailbox is the copy an attacker inside the Cloudflare account
cannot rewrite. Rewriting history would then require also rewriting the operator's mail.

## 6. Protecting the table, and retention

### 6.1 Database rules

Migration 046 adds triggers on `audit_log`:

- `BEFORE DELETE`: abort unless `occurred_at` is more than 6 years old.
- `BEFORE UPDATE`: abort unless the only columns changing are `seq`, `sealed_at`,
  `chain_hash` (each only from NULL) or `archived_at` (only from NULL), and every other
  column is unchanged.

**Fallback if D1 rejects triggers** (plan task 1 decides): no database-level block; the
helper and sealer are the only writers by code review and the coverage test, and the chain,
archive and daily anchor still **detect** any edit. The spec's tamper-evidence goal holds; the
tamper-prevention layer is lost, and the plan records that explicitly.

### 6.2 Retention and blanking

In the existing 03:00 retention sweep:

- **Blanking:** subjects with `redact_after <= now` and `redacted_at IS NULL` get
  `display_name`, `email` and `ip` set to NULL and `redacted_at` set, in one batch with a
  `subject.redact` entry. `redact_after` is set when a shop is deleted or leaves (every
  subject with that `shop_id`), and when an erasure request is recorded (that user's subject).
  Visitor IP subjects get `redact_after = created + 30 days` automatically.
- **Expiry:** entries with `occurred_at` older than 6 years are deleted in bounded batches,
  with one `audit.expire` entry per run (range, count). R2 objects expire through a bucket
  lifecycle rule at the same age, after the lock rule no longer covers them.

## 7. Operator viewer and exports

### 7.1 Activity page

`apps/web/app/routes/dev.activity.tsx`, on the developer dashboard (`DashboardLayout` +
`Sidebar`), developers only. It follows DESIGN.md and the phone layout rules from PR #109.

- Filters: shop, person, action (grouped), outcome, date range. Newest first, paged.
- Each row: time, who (name or "redacted"), action, shop, entity, outcome, and a status badge
  (sealed / archived / pending).
- Expand: `changes_json` as before/after, AI model/route/tokens/cost, the request's other
  entries via `request_id`, and the started/outcome pair via `parent_id`.
- "Check now" on the visible range.
- Opening the page writes `audit.view`.

API: `GET /api/audit` (filters, cursor paging) and `POST /api/audit/verify`, developer role
only, in a new `apps/worker/src/routes/audit.ts`.

### 7.2 Exports

- **Range export:** CSV of the filtered entries plus `proof.json` with the chain hashes at
  both ends of the range, the archive object names covering it, and the nearest daily anchors,
  so a third party can re-verify. Writes `audit.export`.
- **Person export (subject access):** every entry whose `actor_ref` is that person, with
  their details resolved. Writes `data.export`.

## 8. Testing

vitest-pool-workers (real worker, simulated D1/KV/R2), as the current worker suite:

- batch atomicity: a change plus a failing audit statement leaves neither; the route returns
  503;
- two-step: `auditStart` failure refuses the action (spy proves it never ran);
- triggers: update and delete are rejected; one-time sealing and 6-year expiry are allowed
  (or the fallback path's tests, if task 1 falls back);
- sealer: consecutive `seq`, correct chain, lease prevents overlap, `archived_at` only after
  a successful put, re-archive after an injected put failure;
- tamper: editing any hashed column in a test DB makes the check fail at that seq;
- blanking leaves every hash and the chain valid; personal values are gone;
- allow-lists drop unlisted fields;
- coverage: adding an unregistered mutating route makes the coverage test fail;
- both SQL splitters apply a trigger migration intact;
- migration replay: the full chain still replays from `schema.sql` (existing suite).

Staging E2E (runs with the `e2e` label): pause, activate and a mocked regeneration each
produce the expected entries, which seal and archive within two minutes.

## 9. Rollout

1. Migration 046 (tables, indexes, triggers, `audit_seal_state`); `schema.sql` updated;
   splitters fixed. CI applies it on the worker deploy.
2. Operator creates the buckets and lock rules (the runbook gives the exact commands; the
   agent does not run them):
   `npx wrangler r2 bucket create pivot-parlor-audit`,
   `npx wrangler r2 bucket lock add pivot-parlor-audit --name retain-6y --retention-days 2192`,
   and the same for `-staging`.
3. Ship `@repo/audit`, the middleware, the route changes, the sealer and the viewer. Note the
   deploy-trigger gap found on 2026-09-25: `Deploy Worker` ignores changes outside
   `apps/worker/**`, `apps/workers/booking/**`, `packages/types/**` and `packages/utils/**`;
   add `packages/audit/**` and `package-lock.json` to its `paths`.
4. Convert builder, images and audit to workspaces; deploy every background worker by hand
   in the runbook's order.
5. Enable the coverage test as a required check.
6. One-off import: existing `ai_usage_log` rows become `ai.call` entries with
   `historical = 1`, sealed like any other and labelled "historical, not recorded at the
   time" in the viewer.

The trail starts on its go-live date; nothing before it can be reconstructed except the
imported AI usage.

## 10. Non-goals

- Shop-owner view (stage 2) and security events (stage 3).
- Recording ordinary page views or every API read.
- Moving `ai_usage_log`; it stays for cost reporting.
- Replacing Cloudflare worker logs or `wrangler tail`.

## 11. Risks

- **Coverage drift:** a new write path outside a route (a new queue consumer) is missed.
  Mitigation: the coverage test also enumerates queue consumers and cron branches.
- **D1 batch limits:** very large bulk operations may exceed batch size; such operations
  record one summary entry per chunk inside each chunk's batch.
- **Per-minute cron cost:** about 43,800 invocations a month, inside the Workers paid-plan
  allowance; re-check the plan's included requests during rollout.
- **Refusing actions** when D1 is degraded makes the whole back office read-only during an
  outage. This is the chosen trade-off ("nothing happens unlogged"); the alert email makes it
  visible.
- **Trigger support unverified** until plan task 1 (section 6.1 fallback).
