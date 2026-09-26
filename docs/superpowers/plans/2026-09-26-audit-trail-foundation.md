# Audit Trail, Plan 1 of 3: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An append-only, hash-chained, archived and retention-managed audit trail in the API worker, with the site/theme/AI routes behind the 2026-09-25 incident fully instrumented, a runtime floor entry for every other state-changing request, and a developer "Activity" page with checks and exports.

**Architecture:** A new `@repo/audit` package builds entries (canonical SHA-256 `entry_hash`, personal details split into `audit_subjects`) and hands back D1 statements, so each route commits its change and its entry in one `db.batch`. A per-minute cron seals new entries into a chain and archives them to a retention-locked R2 bucket; the 03:00 cron verifies the chain against the archive, emails a daily anchor, blanks due personal details and expires 6-year-old entries. A coverage registry plus a runtime "gap" guard make un-instrumented routes visible and ratcheted down by Plans 2 and 3.

**Tech Stack:** Cloudflare Workers (Hono 4.13), D1 (SQLite), R2, KV, `@cloudflare/vitest-pool-workers`, TypeScript 5.9, Remix (Cloudflare Pages), Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-26-audit-trail-design.md` (approved 2026-09-26, commit bdba758). Read it before starting; this plan argues from it.

## The three plans

The spec is one design but too large for one plan. Each plan ships working software:

1. **This plan (Foundation):** tables and triggers, `@repo/audit`, worker glue, coverage registry and gap guard, the incident routes (site pause/activate/delete/regenerate, all four `/api/ai` write routes), sealer, archive, nightly check, daily anchor, retention, audit API, Activity page, rollout docs.
2. **Plan 2 (API worker routes):** the remaining 61 `pending` routes, the three `pending` crons and the reminder queue consumer, grouped by route file; ends with `PENDING_CEILING = 0` for the API worker.
3. **Plan 3 (background and booking workers):** converts builder/images/audit to workspaces, instruments research, text, chatbot, builder, images, audit and booking (incl. its 14 routes and cron), consumes `origin_actor_ref`, and deploys them.

"All activities are logged" is true only when Plan 3 lands; until then every un-instrumented API request still leaves an `audit.gap` entry (Task 4).

## Global Constraints

- Money is INTEGER pence; never add REAL money columns (CLAUDE.md).
- Every SQL statement uses prepared statements with `.bind()`; never interpolate input.
- Worker JSON responses use `{ success, data?, error? }`.
- Refusal response for an audit write failure, verbatim: HTTP 503, `{ "success": false, "error": "Could not record this action; nothing was changed." }` (spec 4.4).
- Retention: entries 6 years (2192 days); personal details blanked 30 days after `redact_after` is set (spec 1.2, 6.2).
- Sealer cron: `"* * * * *"`; sealing batch 500 rows; lease 50 s; `started` rows without an outcome after 15 minutes become `outcome = unknown` (spec 5.1).
- Alerts: unsealed > 10 minutes, sealed-but-unarchived > 1 hour, any `unknown` outcome, any verify failure (spec 5.3).
- R2 bucket names: `pivot-parlor-audit` (production), `pivot-parlor-audit-staging`; binding `AUDIT_ARCHIVE`; lock rule `retain-6y`, `--retention-days 2192` (spec 5.2).
- Never store passwords, password hashes, tokens, session ids, API keys, card data or full request bodies in any audit column (spec 3.1).
- Do not use em-dashes in user-facing text (CLAUDE.md). The Activity page is user-facing.
- Commits: never `--no-verify`; never `git add .aramid/ .githooks/ .graphite/`; run `aramid check --staged` before each commit; trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Do not push, deploy, create buckets or touch staging/production data without the owner's explicit go-ahead in the moment. Every `wrangler kv`/`d1` command against real data needs `--remote`.
- `sed -i` rewrites CRLF files as LF in this repo; edit with the editor tool or python `newline=""`.
- Worker tests run with `cd apps/worker && npm test` (vitest-pool-workers, per-file simulated D1/KV/R2; `test/apply-schema.ts` replays `schema.sql` + migrations before each file). Console output inside tests is swallowed; put diagnostics in assertion messages.

## Decisions made while planning (owner can veto)

1. **Split into three plans** (above).
2. **Runtime gap guard** (not in the spec): any POST/PUT/PATCH/DELETE that finishes without writing an audit entry records a floor entry `audit.gap` (method, path, status, actor) after the response. It is best effort (written after the fact), so it does not satisfy "refuse if unlogged"; it guarantees visibility while Plans 2 and 3 are in progress and catches future regressions.
3. **`archive_key` column** added to `audit_log` so the verifier can find each row's archived copy without listing the bucket.
4. **`audit_seal_state`** (single row) holds the sealer lease plus `last_verified_seq`, `walk_cursor_seq`, `expired_through_seq`, `expired_chain_hash`.
5. **Visitor-IP subjects use random ids** found by a per-day lookup, not a hash of the IP (an IPv4 hash is reversible by enumeration, which would defeat blanking).
6. **User subjects are filled inside the batch** with `INSERT ... SELECT name, email FROM platform_users` (no extra round trip).
7. **Erasure-request endpoint** added (`POST /api/audit/subjects/:userId/erase`); the spec assumed a flow that does not exist.
8. **`via` is `api`** for every request to the worker; the Remix BFF makes "dashboard" indistinguishable.
9. **Weekly full walk** becomes a rotating cursor of up to 20,000 rows per night (a full walk would exceed CPU limits as the table grows).
10. **Gap guard skips 404 and 405** (unmatched paths and bots).
11. **Deploy Worker `paths`** also gains `packages/llm/**` (found missing: `@repo/llm` changes never redeployed the API worker).
12. **`started` rows have `outcome = NULL`**; `unknown` is reserved for the sealer's crash marker.

## Review Focus

1. **A route that returns a Response from inside `audit.run`** (generate-site returns 400/503 Responses instead of throwing): the outcome row must say `failed` with the status, not `succeeded`. Test: Task 6 Step 1 (generate-site test).
2. **Two concurrent sealer runs** (a slow run overlapping the next minute): no duplicate `seq`, no fork in the chain. Test: Task 8 Step 1 (`lease` test) plus the `seq UNIQUE` constraint.
3. **An archive `put` that succeeded while the `archived_at` update failed**: the retry meets a locked, existing object and must accept it when identical instead of failing forever. Test: Task 8 Step 3 (`archivePending accepts an identical pre-existing object`).
4. **A tamperer who edits a row AND recomputes every later hash**: the DB-only check passes; the archive comparison must fail. Test: Task 9 Step 1.
5. **Blanking a person after their entries are sealed**: every hash and the chain must still verify, and the viewer shows "redacted". Test: Task 10 Step 1.

---

### Task 1: Trigger-safe SQL splitting, proven on the local simulator

**Files:**
- Create: `scripts/sql-statements.mjs`
- Create: `scripts/sql-statements.d.mts`
- Modify: `scripts/migrate.mjs` (the local `statements()` function, around line 124)
- Modify: `apps/worker/test/apply-schema.ts` (the local `statements()` function, around line 19)
- Test: `apps/worker/test/sql-statements.test.ts`

**Interfaces:**
- Produces: `statements(sql: string): string[]` from `scripts/sql-statements.mjs`, used by both appliers. A `CREATE [TEMP] TRIGGER ... BEGIN ...; END` is returned as one statement.

- [ ] **Step 1: Write the failing test**

`apps/worker/test/sql-statements.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { statements } from "../../../scripts/sql-statements.mjs";

describe("statements()", () => {
  it("splits plain statements and drops comment lines", () => {
    const sql = "-- a comment; with a semicolon\nCREATE TABLE a (x INTEGER);\n\nINSERT INTO a VALUES (1);";
    expect(statements(sql)).toEqual(["CREATE TABLE a (x INTEGER)", "INSERT INTO a VALUES (1)"]);
  });

  it("keeps a trigger body in one statement", () => {
    const sql = [
      "CREATE TABLE t (x INTEGER);",
      "CREATE TRIGGER t_no_delete BEFORE DELETE ON t",
      "BEGIN",
      "  SELECT RAISE(ABORT, 'no');",
      "END;",
      "INSERT INTO t VALUES (1);",
    ].join("\n");
    const out = statements(sql);
    expect(out).toHaveLength(3);
    expect(out[1]).toMatch(/^CREATE TRIGGER t_no_delete[\s\S]*RAISE\(ABORT, 'no'\);[\s\S]*END$/);
  });

  it("rejects an unterminated trigger", () => {
    expect(() => statements("CREATE TRIGGER x BEFORE DELETE ON t BEGIN SELECT 1;")).toThrow(/Unterminated CREATE TRIGGER/);
  });

  it("the simulator accepts a trigger and RAISE(ABORT) fires", async () => {
    for (const s of statements(
      "CREATE TABLE probe_t (x INTEGER);\nCREATE TRIGGER probe_t_nd BEFORE DELETE ON probe_t\nBEGIN\n  SELECT RAISE(ABORT, 'probe blocked');\nEND;\nINSERT INTO probe_t VALUES (1);"
    )) {
      await env.DB.prepare(s).run();
    }
    await expect(env.DB.prepare("DELETE FROM probe_t").run()).rejects.toThrow(/probe blocked/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/worker && npx vitest run test/sql-statements.test.ts`
Expected: FAIL, cannot resolve `../../../scripts/sql-statements.mjs`.

- [ ] **Step 3: Write the shared splitter**

`scripts/sql-statements.mjs`:

```js
/**
 * Split a migration file into executable statements. Shared by
 * scripts/migrate.mjs and apps/worker/test/apply-schema.ts so the production
 * applier and the test replay can never disagree.
 *
 * Comment lines are stripped FIRST (a ';' inside a comment would split the
 * file mid-comment). A CREATE TRIGGER body contains ';' before its END, so
 * trigger segments are re-joined until the segment that ends with END.
 */
const TRIGGER_START = /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;
const ENDS_WITH_END = /\bEND$/i;

export function statements(sql) {
  const parts = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";");
  const out = [];
  let trigger = null;
  for (const raw of parts) {
    const part = raw.trim();
    if (trigger !== null) {
      trigger += ";" + raw;
      if (ENDS_WITH_END.test(part)) {
        out.push(trigger.trim());
        trigger = null;
      }
      continue;
    }
    if (!part) continue;
    if (TRIGGER_START.test(part) && !ENDS_WITH_END.test(part)) {
      trigger = raw;
      continue;
    }
    out.push(part);
  }
  if (trigger !== null) {
    throw new Error(`Unterminated CREATE TRIGGER (missing END;): ${trigger.trim().slice(0, 120)}`);
  }
  return out;
}
```

`scripts/sql-statements.d.mts`:

```ts
export declare function statements(sql: string): string[];
```

- [ ] **Step 4: Use it in both appliers**

In `scripts/migrate.mjs`, delete the local `function statements(sql) { ... }` block and add at the top with the other imports:

```js
import { statements } from "./sql-statements.mjs";
```

In `apps/worker/test/apply-schema.ts`, delete the local `function statements(sql: string): string[] { ... }` block and add after the existing imports:

```ts
import { statements } from "../../../scripts/sql-statements.mjs";
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/worker && npx vitest run test/sql-statements.test.ts` then `npm test`
Expected: 4 passed; the full suite still passes (the replay uses the new splitter on every existing migration).

Also run the production applier against the local simulator to prove it still parses every file: `node scripts/migrate.mjs` (local D1, from the repo root)
Expected: every file reports `✓` or "already applied"; no parse errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/sql-statements.mjs scripts/sql-statements.d.mts scripts/migrate.mjs apps/worker/test/apply-schema.ts apps/worker/test/sql-statements.test.ts
aramid check --staged
git commit -m "fix(migrations): keep CREATE TRIGGER bodies intact when splitting SQL"
```

- [ ] **Step 7: Owner-gated staging probe (do not skip, do not run without asking)**

The simulator is real SQLite; production D1 may differ. Ask the owner: "May I create and drop a throwaway table and trigger on the STAGING database to prove D1 accepts triggers?" Only on a yes, run from `apps/worker`:

```bash
npx wrangler d1 execute pivot-parlor-db-staging --remote --command "CREATE TABLE zz_trigger_probe (x INTEGER)"
npx wrangler d1 execute pivot-parlor-db-staging --remote --command "CREATE TRIGGER zz_trigger_probe_nd BEFORE DELETE ON zz_trigger_probe BEGIN SELECT RAISE(ABORT, 'probe blocked'); END"
npx wrangler d1 execute pivot-parlor-db-staging --remote --command "INSERT INTO zz_trigger_probe VALUES (1)"
npx wrangler d1 execute pivot-parlor-db-staging --remote --command "DELETE FROM zz_trigger_probe"
npx wrangler d1 execute pivot-parlor-db-staging --remote --command "DROP TABLE zz_trigger_probe"
```

Expected: the DELETE fails with `probe blocked`; DROP TABLE removes the trigger with the table. **If CREATE TRIGGER is rejected**, stop and report: Task 2 then ships without the two triggers (spec 6.1 fallback), and Task 2's trigger tests are replaced by a test that `audit_log` has no UPDATE/DELETE code path outside `packages/audit` and `apps/worker/src/audit` (grep-based). Record the outcome in the task report either way.

---

### Task 2: Migration 046: audit tables, indexes and protective triggers

**Files:**
- Create: `apps/worker/src/db/migrations/046_audit_trail.sql`
- Modify: `apps/worker/src/db/schema.sql` (append the same objects at the end)
- Modify: `CLAUDE.md` (two occurrences of "currently up to `042`" become "currently up to `046`")
- Test: `apps/worker/test/audit-triggers.test.ts`

**Interfaces:**
- Produces: tables `audit_log`, `audit_subjects`, `audit_seal_state` (row `id = 1` always present) exactly as below. Every later task relies on these column names.

- [ ] **Step 1: Write the failing test**

`apps/worker/test/audit-triggers.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const insertRow = (id: string, occurredAt: string) =>
  env.DB.prepare(
    `INSERT INTO audit_log (id, occurred_at, entry_hash, actor_type, via, action, phase, outcome, worker, historical)
     VALUES (?, ?, 'h', 'system', 'cron', 'audit.verify', 'done', 'succeeded', 'test', 0)`
  ).bind(id, occurredAt).run();

describe("audit_log protection", () => {
  it("has the seal-state row", async () => {
    const row = await env.DB.prepare("SELECT id FROM audit_seal_state WHERE id = 1").first();
    expect(row).not.toBeNull();
  });

  it("rejects editing a hashed column", async () => {
    await insertRow("t-edit", new Date().toISOString());
    await expect(
      env.DB.prepare("UPDATE audit_log SET reason = 'x' WHERE id = 't-edit'").run()
    ).rejects.toThrow(/append-only/);
  });

  it("allows sealing columns exactly once", async () => {
    await insertRow("t-seal", new Date().toISOString());
    await env.DB.prepare(
      "UPDATE audit_log SET seq = 1, sealed_at = 'now', chain_hash = 'c' WHERE id = 't-seal'"
    ).run();
    await env.DB.prepare(
      "UPDATE audit_log SET archived_at = 'now', archive_key = 'k' WHERE id = 't-seal'"
    ).run();
    await expect(
      env.DB.prepare("UPDATE audit_log SET chain_hash = 'other' WHERE id = 't-seal'").run()
    ).rejects.toThrow(/append-only/);
  });

  it("rejects deleting a young row and allows deleting a 7-year-old one", async () => {
    await insertRow("t-young", new Date().toISOString());
    await expect(env.DB.prepare("DELETE FROM audit_log WHERE id = 't-young'").run()).rejects.toThrow(/append-only/);
    const old = new Date(Date.now() - 7 * 365 * 24 * 3600 * 1000).toISOString();
    await insertRow("t-old", old);
    await env.DB.prepare("DELETE FROM audit_log WHERE id = 't-old'").run();
    const gone = await env.DB.prepare("SELECT id FROM audit_log WHERE id = 't-old'").first();
    expect(gone).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/worker && npx vitest run test/audit-triggers.test.ts`
Expected: FAIL, `no such table: audit_seal_state`.

- [ ] **Step 3: Write the migration**

`apps/worker/src/db/migrations/046_audit_trail.sql`:

```sql
-- Audit trail (spec docs/superpowers/specs/2026-09-26-audit-trail-design.md).
-- audit_log is append-only: the triggers below allow only the sealer's
-- one-time columns and deletion after 6 years.

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  occurred_at   TEXT NOT NULL,
  seq           INTEGER UNIQUE,
  sealed_at     TEXT,
  archived_at   TEXT,
  archive_key   TEXT,
  entry_hash    TEXT NOT NULL,
  chain_hash    TEXT,
  actor_type    TEXT NOT NULL,
  actor_ref     TEXT,
  actor_role    TEXT,
  via           TEXT NOT NULL,
  action        TEXT NOT NULL,
  phase         TEXT NOT NULL,
  outcome       TEXT,
  reason        TEXT,
  shop_id       TEXT,
  entity_type   TEXT,
  entity_id     TEXT,
  changes_json  TEXT,
  details_json  TEXT,
  request_id    TEXT,
  parent_id     TEXT,
  worker        TEXT NOT NULL,
  ip_ref        TEXT,
  historical    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_audit_log_shop_time ON audit_log (shop_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_time ON audit_log (actor_ref, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_time ON audit_log (action, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log (occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_audit_log_parent ON audit_log (parent_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_request ON audit_log (request_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_unsealed ON audit_log (occurred_at) WHERE sealed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_unarchived ON audit_log (seq) WHERE sealed_at IS NOT NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_subjects (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  user_id       TEXT,
  shop_id       TEXT,
  display_name  TEXT,
  email         TEXT,
  ip            TEXT,
  day           TEXT,
  created_at    TEXT NOT NULL,
  redact_after  TEXT,
  redacted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_subjects_ip_day ON audit_subjects (kind, day, ip);
CREATE INDEX IF NOT EXISTS idx_audit_subjects_shop ON audit_subjects (shop_id);
CREATE INDEX IF NOT EXISTS idx_audit_subjects_redact ON audit_subjects (redact_after) WHERE redacted_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_seal_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  holder               TEXT,
  lease_until          TEXT,
  last_verified_seq    INTEGER NOT NULL DEFAULT 0,
  walk_cursor_seq      INTEGER NOT NULL DEFAULT 0,
  expired_through_seq  INTEGER NOT NULL DEFAULT 0,
  expired_chain_hash   TEXT
);

INSERT OR IGNORE INTO audit_seal_state (id) VALUES (1);

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
WHEN OLD.occurred_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2192 days')
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_seal_only
BEFORE UPDATE ON audit_log
WHEN NOT (
  OLD.id IS NEW.id AND OLD.occurred_at IS NEW.occurred_at AND OLD.entry_hash IS NEW.entry_hash
  AND OLD.actor_type IS NEW.actor_type AND OLD.actor_ref IS NEW.actor_ref AND OLD.actor_role IS NEW.actor_role
  AND OLD.via IS NEW.via AND OLD.action IS NEW.action AND OLD.phase IS NEW.phase
  AND OLD.outcome IS NEW.outcome AND OLD.reason IS NEW.reason AND OLD.shop_id IS NEW.shop_id
  AND OLD.entity_type IS NEW.entity_type AND OLD.entity_id IS NEW.entity_id
  AND OLD.changes_json IS NEW.changes_json AND OLD.details_json IS NEW.details_json
  AND OLD.request_id IS NEW.request_id AND OLD.parent_id IS NEW.parent_id
  AND OLD.worker IS NEW.worker AND OLD.ip_ref IS NEW.ip_ref AND OLD.historical IS NEW.historical
  AND (OLD.seq IS NULL OR OLD.seq IS NEW.seq)
  AND (OLD.sealed_at IS NULL OR OLD.sealed_at IS NEW.sealed_at)
  AND (OLD.chain_hash IS NULL OR OLD.chain_hash IS NEW.chain_hash)
  AND (OLD.archived_at IS NULL OR OLD.archived_at IS NEW.archived_at)
  AND (OLD.archive_key IS NULL OR OLD.archive_key IS NEW.archive_key)
)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
```

Append the identical text (without the first three comment lines) to the end of `apps/worker/src/db/schema.sql` under a comment `-- 046_audit_trail`.

In `CLAUDE.md`, change both "currently up to `042`" to "currently up to `046`".

- [ ] **Step 4: Run the tests**

Run: `cd apps/worker && npx vitest run test/audit-triggers.test.ts` then `npm test`
Expected: 4 passed; full suite passes (the replay applies 046 twice, once via the snapshot and once as a file; `IF NOT EXISTS` and `INSERT OR IGNORE` make that a no-op).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/db/migrations/046_audit_trail.sql apps/worker/src/db/schema.sql CLAUDE.md apps/worker/test/audit-triggers.test.ts
aramid check --staged
git commit -m "feat(audit): migration 046 - append-only audit_log, subjects and seal state"
```

---

### Task 3: `@repo/audit` package: catalogue, hashing, allow-lists and the recorder

**Files:**
- Create: `packages/audit/package.json`, `packages/audit/tsconfig.json`, `packages/audit/vitest.config.ts`
- Create: `packages/audit/src/index.ts`, `src/actions.ts`, `src/types.ts`, `src/canonical.ts`, `src/allowlist.ts`, `src/recorder.ts`
- Create: `packages/audit/test/canonical.test.ts`, `packages/audit/test/allowlist.test.ts`, `packages/audit/test/actions.test.ts`
- Modify: `apps/worker/package.json` (add `"@repo/audit": "*"` to dependencies)
- Test: `apps/worker/test/audit-recorder.test.ts` (recorder against the simulated D1)

**Interfaces:**
- Produces (all exported from `@repo/audit`):
  - `AUDIT_ACTIONS`, `type AuditAction`, `isAuditAction(x: unknown): x is AuditAction`
  - `type ActorType`, `type Via`, `type Outcome`, `type Phase`, `interface AuditActor`, `interface AuditEntryInput`, `interface AuditRow`, `AUDIT_COLUMNS`
  - `GENESIS`, `canonicalJson(row)`, `sha256Hex(s)`, `entryHash(row)`, `chainHash(prev, entry)`, `archiveLine(row)`
  - `CHANGE_ALLOWLIST`, `filterChanges(entityType, changes)`
  - `AuditWriteError`, `createAuditRecorder(base: RecorderBase): AuditRecorder`, `userSubjectId(userId)`
  - `AuditRecorder.statements(input): Promise<D1PreparedStatement[]>`, `.write(input): Promise<string>`, `.run<T>(input, fn, describe?): Promise<T>`

- [ ] **Step 1: Scaffold the package**

`packages/audit/package.json`:

```json
{
  "name": "@repo/audit",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "check-types": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241022.0",
    "@repo/typescript-config": "*",
    "typescript": "5.9.2",
    "vitest": "^4.1.8"
  }
}
```

`packages/audit/tsconfig.json`:

```json
{
  "extends": "@repo/typescript-config/base.json",
  "compilerOptions": {
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "noEmit": true,
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "test"]
}
```

`packages/audit/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

Add `"@repo/audit": "*"` to `apps/worker/package.json` dependencies, then run `npm install` at the repo root.
Expected: `npm ls @repo/audit` shows it linked under `worker`. Check `git diff package-lock.json` adds only the `packages/audit` workspace entries.

- [ ] **Step 2: Write the failing package tests**

`packages/audit/test/canonical.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalJson, chainHash, entryHash, GENESIS, sha256Hex } from "../src/canonical";
import type { AuditRow } from "../src/types";

const row: AuditRow = {
  id: "e1", occurred_at: "2026-09-26T10:00:00.000Z", seq: null, sealed_at: null, archived_at: null,
  archive_key: null, entry_hash: "", chain_hash: null, actor_type: "developer", actor_ref: "subj_user_u1",
  actor_role: "developer", via: "api", action: "site.pause", phase: "done", outcome: "succeeded",
  reason: null, shop_id: "s1", entity_type: "shop_site", entity_id: "s1",
  changes_json: '{"website_status":["live","paused"]}', details_json: null, request_id: "r1",
  parent_id: null, worker: "pivot-parlor-api", ip_ref: null, historical: 0,
};

describe("canonical hashing", () => {
  it("is independent of key order and ignores sealing columns", async () => {
    const reordered = Object.fromEntries(Object.entries(row).reverse()) as AuditRow;
    const sealed = { ...row, seq: 9, sealed_at: "x", chain_hash: "y", archived_at: "z", archive_key: "k", entry_hash: "q" };
    expect(canonicalJson(reordered)).toBe(canonicalJson(row));
    expect(await entryHash(sealed)).toBe(await entryHash(row));
  });

  it("changes when any hashed field changes", async () => {
    expect(await entryHash({ ...row, reason: "edited" })).not.toBe(await entryHash(row));
    expect(await entryHash({ ...row, actor_ref: "subj_user_u2" })).not.toBe(await entryHash(row));
  });

  it("chains from GENESIS with SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await chainHash(GENESIS, "e")).toBe(await sha256Hex(`${GENESIS}e`));
  });
});
```

`packages/audit/test/allowlist.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { filterChanges } from "../src/allowlist";

describe("filterChanges", () => {
  it("keeps only allow-listed fields", () => {
    expect(filterChanges("shop_site", { website_status: ["live", "paused"], secret: ["a", "b"] })).toEqual({
      website_status: ["live", "paused"],
    });
  });
  it("drops everything for an unknown entity type", () => {
    expect(filterChanges("mystery", { a: [1, 2] })).toBeNull();
  });
  it("returns null when nothing survives", () => {
    expect(filterChanges("shop_site", { password: ["x", "y"] })).toBeNull();
  });
});
```

`packages/audit/test/actions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, isAuditAction } from "../src/actions";

describe("action catalogue", () => {
  it("accepts catalogue actions and rejects others", () => {
    expect(isAuditAction("site.pause")).toBe(true);
    expect(isAuditAction("site.explode")).toBe(false);
    expect(isAuditAction(42)).toBe(false);
  });
  it("has no duplicates", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd packages/audit && npx vitest run`
Expected: FAIL, cannot resolve `../src/canonical` etc.

- [ ] **Step 4: Write the package sources**

`packages/audit/src/actions.ts`:

```ts
/** Fixed action catalogue (spec 3.3). Add actions here, never inline strings. */
export const AUDIT_ACTIONS = [
  "site.activate", "site.pause", "site.regenerate.request", "site.regenerate.complete", "site.edit",
  "theme.generate", "theme.apply", "theme.compare",
  "shop.create", "shop.update", "shop.delete", "shop.settings.update",
  "service.create", "service.update", "service.delete",
  "staff.create", "staff.update", "staff.delete",
  "schedule.create", "schedule.update", "schedule.delete",
  "product.create", "product.update", "product.delete",
  "booking.create", "booking.update", "booking.cancel", "booking.status",
  "walkin.join", "walkin.serve", "walkin.remove",
  "pos.sale", "payment.refund.issue", "payment.payout", "payment.stripe.webhook",
  "customer.view", "data.export",
  "audit.view", "audit.export", "audit.verify", "audit.expire", "audit.seal.alert",
  "audit.gap", "audit.anchor", "audit.import.historical",
  "ai.call", "ai.chatbot_model.set", "ai.registry.refresh",
  "subject.redact", "subject.erase_request",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export function isAuditAction(x: unknown): x is AuditAction {
  return typeof x === "string" && ACTION_SET.has(x);
}
```

`packages/audit/src/types.ts`:

```ts
import type { AuditAction } from "./actions";

export type ActorType = "developer" | "admin" | "staff" | "customer" | "system" | "anonymous";
export type Via = "dashboard" | "api" | "cron" | "queue" | "webhook";
export type Outcome = "succeeded" | "refused" | "failed" | "unknown";
export type Phase = "done" | "started" | "outcome";

export interface AuditActor {
  type: ActorType;
  userId?: string | null;
  role?: string | null;
  shopId?: string | null;
  ip?: string | null;
}

export interface AuditEntryInput {
  action: AuditAction;
  /** Required for phase "done"/"outcome"; must be omitted for "started". */
  outcome?: Outcome;
  reason?: string | null;
  shopId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** {field: [before, after]}; filtered through CHANGE_ALLOWLIST[entityType]. */
  changes?: Record<string, [unknown, unknown]> | null;
  details?: Record<string, unknown> | null;
  parentId?: string | null;
  phase?: Phase;
  /** Internal: historical import and tests only. */
  id?: string;
  occurredAt?: string;
  historical?: boolean;
}

/** Column order of audit_log inserts (sealing columns excluded). */
export const AUDIT_COLUMNS = [
  "id", "occurred_at", "entry_hash", "actor_type", "actor_ref", "actor_role", "via", "action",
  "phase", "outcome", "reason", "shop_id", "entity_type", "entity_id", "changes_json",
  "details_json", "request_id", "parent_id", "worker", "ip_ref", "historical",
] as const;

export interface AuditRow {
  id: string;
  occurred_at: string;
  seq: number | null;
  sealed_at: string | null;
  archived_at: string | null;
  archive_key: string | null;
  entry_hash: string;
  chain_hash: string | null;
  actor_type: ActorType;
  actor_ref: string | null;
  actor_role: string | null;
  via: Via;
  action: string;
  phase: Phase;
  outcome: Outcome | null;
  reason: string | null;
  shop_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  changes_json: string | null;
  details_json: string | null;
  request_id: string | null;
  parent_id: string | null;
  worker: string;
  ip_ref: string | null;
  historical: number;
}
```

`packages/audit/src/canonical.ts`:

```ts
import type { AuditRow } from "./types";

export const GENESIS = "GENESIS";

/** Columns covered by entry_hash: everything except the sealer's and the hash itself. */
const HASHED = [
  "action", "actor_ref", "actor_role", "actor_type", "changes_json", "details_json", "entity_id",
  "entity_type", "historical", "id", "ip_ref", "occurred_at", "outcome", "parent_id", "phase",
  "reason", "request_id", "shop_id", "via", "worker",
] as const;

export function canonicalJson(row: AuditRow): string {
  const out: Record<string, unknown> = {};
  for (const k of HASHED) out[k] = row[k] ?? null;
  return JSON.stringify(out);
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function entryHash(row: AuditRow): Promise<string> {
  return sha256Hex(canonicalJson(row));
}

export function chainHash(prevChain: string, entry: string): Promise<string> {
  return sha256Hex(`${prevChain}${entry}`);
}

/** The archived form of a sealed row: every column except archive bookkeeping. */
export function archiveLine(row: AuditRow): string {
  const { archived_at: _a, archive_key: _k, ...rest } = row;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(rest).sort()) sorted[k] = (rest as Record<string, unknown>)[k] ?? null;
  return JSON.stringify(sorted);
}
```

`packages/audit/src/allowlist.ts`:

```ts
/** Fields that may appear in changes_json, per entity type (spec 4.3). */
export const CHANGE_ALLOWLIST: Record<string, readonly string[]> = {
  shop_site: ["website_status", "template", "headline", "tagline"],
  shop: ["name", "slug", "type", "phone", "status", "is_active", "ai_model"],
  theme: ["ai_model", "primaryColor", "accentColor", "fontHeading", "fontBody", "heroHeadline", "tagline"],
  platform_setting: ["chatbot_model"],
  generation_job: ["status", "text_model", "image_model", "skip_images", "composer", "template"],
  audit_subject: ["redact_after"],
};

export function filterChanges(
  entityType: string | null | undefined,
  changes: Record<string, [unknown, unknown]> | null | undefined
): Record<string, [unknown, unknown]> | null {
  if (!changes || !entityType) return null;
  const allowed = CHANGE_ALLOWLIST[entityType];
  if (!allowed) return null;
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of allowed) if (k in changes) out[k] = changes[k]!;
  return Object.keys(out).length > 0 ? out : null;
}
```

`packages/audit/src/recorder.ts`:

```ts
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { isAuditAction } from "./actions";
import { filterChanges } from "./allowlist";
import { entryHash } from "./canonical";
import { AUDIT_COLUMNS, type AuditActor, type AuditEntryInput, type AuditRow, type Outcome, type Via } from "./types";

export class AuditWriteError extends Error {
  constructor(message: string, readonly original?: unknown) {
    super(message);
    this.name = "AuditWriteError";
  }
}

export interface RecorderBase {
  db: D1Database;
  worker: string;
  via: Via;
  actor: AuditActor;
  requestId: string | null;
  /** Called when statements are handed out; the API worker's gap guard uses it. */
  onWrite?: () => void;
  now?: () => Date;
}

export interface AuditRunResult {
  outcome?: Outcome;
  reason?: string | null;
  details?: Record<string, unknown> | null;
  changes?: Record<string, [unknown, unknown]> | null;
  entityId?: string | null;
}

export interface AuditRecorder {
  statements(input: AuditEntryInput): Promise<D1PreparedStatement[]>;
  write(input: AuditEntryInput): Promise<string>;
  run<T>(
    input: Omit<AuditEntryInput, "outcome" | "phase">,
    fn: () => Promise<T>,
    describe?: (result: T) => AuditRunResult
  ): Promise<T>;
}

export const userSubjectId = (userId: string): string => `subj_user_${userId}`;

const REASON_MAX = 500;
const DAY_MS = 24 * 3600 * 1000;

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, REASON_MAX);
}

export function createAuditRecorder(base: RecorderBase): AuditRecorder {
  const nowIso = () => (base.now?.() ?? new Date()).toISOString();

  async function subjects(at: string): Promise<{ actorRef: string | null; ipRef: string | null; stmts: D1PreparedStatement[] }> {
    const stmts: D1PreparedStatement[] = [];
    let actorRef: string | null = null;
    if (base.actor.userId) {
      actorRef = userSubjectId(base.actor.userId);
      stmts.push(
        base.db
          .prepare(
            `INSERT INTO audit_subjects (id, kind, user_id, shop_id, display_name, email, created_at)
             SELECT ?, 'user', pu.id, pu.shop_id, pu.name, pu.email, ? FROM platform_users pu WHERE pu.id = ?
             ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, email = excluded.email,
               shop_id = excluded.shop_id
             WHERE audit_subjects.redacted_at IS NULL`
          )
          .bind(actorRef, at, base.actor.userId)
      );
    }
    let ipRef: string | null = null;
    const ip = base.actor.ip?.trim();
    if (ip) {
      const day = at.slice(0, 10);
      const found = await base.db
        .prepare("SELECT id FROM audit_subjects WHERE kind = 'visitor_ip' AND day = ? AND ip = ? LIMIT 1")
        .bind(day, ip)
        .first<{ id: string }>();
      if (found) {
        ipRef = found.id;
      } else {
        ipRef = `subj_ip_${crypto.randomUUID()}`;
        const redactAfter = new Date(Date.parse(at) + 30 * DAY_MS).toISOString();
        stmts.push(
          base.db
            .prepare(
              "INSERT INTO audit_subjects (id, kind, ip, day, created_at, redact_after) VALUES (?, 'visitor_ip', ?, ?, ?, ?)"
            )
            .bind(ipRef, ip, day, at, redactAfter)
        );
      }
    }
    return { actorRef, ipRef, stmts };
  }

  async function prepare(input: AuditEntryInput): Promise<{ id: string; stmts: D1PreparedStatement[] }> {
    try {
      if (!isAuditAction(input.action)) throw new AuditWriteError(`Unknown audit action: ${String(input.action)}`);
      const phase = input.phase ?? "done";
      if (phase === "started" && input.outcome) throw new AuditWriteError("A started entry has no outcome");
      if (phase !== "started" && !input.outcome) throw new AuditWriteError("outcome is required");
      const at = input.occurredAt ?? nowIso();
      const refs = await subjects(at);
      const changes = filterChanges(input.entityType, input.changes);
      const row: AuditRow = {
        id: input.id ?? crypto.randomUUID(),
        occurred_at: at,
        seq: null, sealed_at: null, archived_at: null, archive_key: null, chain_hash: null,
        entry_hash: "",
        actor_type: base.actor.type,
        actor_ref: refs.actorRef,
        actor_role: base.actor.role ?? null,
        via: base.via,
        action: input.action,
        phase,
        outcome: phase === "started" ? null : input.outcome!,
        reason: input.reason ? input.reason.slice(0, REASON_MAX) : null,
        shop_id: input.shopId ?? null,
        entity_type: input.entityType ?? null,
        entity_id: input.entityId ?? null,
        changes_json: changes ? JSON.stringify(changes) : null,
        details_json: input.details ? JSON.stringify(input.details) : null,
        request_id: base.requestId,
        parent_id: input.parentId ?? null,
        worker: base.worker,
        ip_ref: refs.ipRef,
        historical: input.historical ? 1 : 0,
      };
      row.entry_hash = await entryHash(row);
      const insert = base.db
        .prepare(
          `INSERT INTO audit_log (${AUDIT_COLUMNS.join(", ")}) VALUES (${AUDIT_COLUMNS.map(() => "?").join(", ")})`
        )
        .bind(...AUDIT_COLUMNS.map((c) => row[c]));
      base.onWrite?.();
      return { id: row.id, stmts: [...refs.stmts, insert] };
    } catch (err) {
      throw err instanceof AuditWriteError ? err : new AuditWriteError("Audit entry could not be prepared", err);
    }
  }

  async function write(input: AuditEntryInput): Promise<string> {
    const { id, stmts } = await prepare(input);
    try {
      await base.db.batch(stmts);
    } catch (err) {
      throw new AuditWriteError("Audit entry could not be written", err);
    }
    return id;
  }

  async function writeOutcome(input: AuditEntryInput): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await write(input);
        return;
      } catch (err) {
        if (attempt === 1) {
          // The action already happened; the sealer marks the started row "unknown".
          console.error("[audit] outcome entry could not be written", input.action, input.parentId, err);
        }
      }
    }
  }

  return {
    async statements(input) {
      return (await prepare(input)).stmts;
    },
    write,
    async run<T>(
      input: Omit<AuditEntryInput, "outcome" | "phase">,
      fn: () => Promise<T>,
      describe?: (result: T) => AuditRunResult
    ): Promise<T> {
      const startedId = await write({ ...input, phase: "started" });
      let result: T;
      try {
        result = await fn();
      } catch (err) {
        await writeOutcome({ ...input, phase: "outcome", outcome: "failed", reason: errorMessage(err), parentId: startedId });
        throw err;
      }
      const extra = describe ? describe(result) : {};
      await writeOutcome({
        ...input,
        phase: "outcome",
        outcome: extra.outcome ?? "succeeded",
        reason: extra.reason ?? null,
        details: extra.details ?? input.details ?? null,
        changes: extra.changes ?? input.changes ?? null,
        entityId: extra.entityId ?? input.entityId ?? null,
        parentId: startedId,
      });
      return result;
    },
  };
}
```

`packages/audit/src/index.ts`:

```ts
export * from "./actions";
export * from "./types";
export * from "./canonical";
export * from "./allowlist";
export * from "./recorder";
```

- [ ] **Step 5: Run the package tests and type-check**

Run: `cd packages/audit && npx vitest run && npx tsc --noEmit`
Expected: 8 passed; tsc clean.

- [ ] **Step 6: Write the recorder's D1 test**

`apps/worker/test/audit-recorder.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AuditWriteError, createAuditRecorder, entryHash, type AuditRow } from "@repo/audit";
import { seedShop, seedUser } from "./helpers";

const recorder = (userId: string | null, ip: string | null = "203.0.113.7") =>
  createAuditRecorder({
    db: env.DB as never,
    worker: "test",
    via: "api",
    actor: userId ? { type: "developer", userId, role: "developer", ip } : { type: "anonymous", ip },
    requestId: "req-1",
  });

describe("audit recorder", () => {
  it("writes an entry whose hash matches, with subjects split out", async () => {
    const shopId = await seedShop("Rec Shop");
    const userId = await seedUser("developer", null);
    const id = await recorder(userId).write({
      action: "site.pause", outcome: "succeeded", shopId, entityType: "shop_site", entityId: shopId,
      changes: { website_status: ["live", "paused"], secret: ["x", "y"] },
    });
    const row = await env.DB.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<AuditRow>();
    expect(row!.entry_hash).toBe(await entryHash(row!));
    expect(row!.changes_json).toBe('{"website_status":["live","paused"]}');
    expect(row!.actor_ref).toBe(`subj_user_${userId}`);
    const subject = await env.DB.prepare("SELECT email, kind FROM audit_subjects WHERE id = ?").bind(row!.actor_ref).first<{ email: string; kind: string }>();
    expect(subject).toEqual({ email: `${userId}@test.local`, kind: "user" });
    const ip = await env.DB.prepare("SELECT ip, redact_after FROM audit_subjects WHERE id = ?").bind(row!.ip_ref).first<{ ip: string; redact_after: string }>();
    expect(ip!.ip).toBe("203.0.113.7");
    expect(Date.parse(ip!.redact_after) - Date.parse(row!.occurred_at)).toBe(30 * 24 * 3600 * 1000);
  });

  it("reuses one IP subject per day", async () => {
    const a = await recorder(null, "198.51.100.1").write({ action: "audit.gap", outcome: "succeeded" });
    const b = await recorder(null, "198.51.100.1").write({ action: "audit.gap", outcome: "succeeded" });
    const refs = await env.DB.prepare("SELECT DISTINCT ip_ref FROM audit_log WHERE id IN (?, ?)").bind(a, b).all();
    expect(refs.results).toHaveLength(1);
  });

  it("run() writes started and outcome rows, and failed on throw", async () => {
    const rec = recorder(null);
    await expect(rec.run({ action: "ai.call" }, async () => { throw new Error("vendor 401"); })).rejects.toThrow("vendor 401");
    const rows = await env.DB.prepare("SELECT phase, outcome, reason, parent_id, id FROM audit_log WHERE action = 'ai.call' ORDER BY occurred_at, phase DESC").all<{ phase: string; outcome: string | null; reason: string | null; parent_id: string | null; id: string }>();
    const started = rows.results!.find((r) => r.phase === "started")!;
    const outcome = rows.results!.find((r) => r.parent_id === started.id)!;
    expect(started.outcome).toBeNull();
    expect(outcome).toMatchObject({ phase: "outcome", outcome: "failed", reason: "vendor 401" });
  });

  it("run() refuses the action when the started entry cannot be written", async () => {
    await env.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_off").run();
    let ran = false;
    try {
      await expect(recorder(null).run({ action: "ai.call" }, async () => { ran = true; })).rejects.toBeInstanceOf(AuditWriteError);
      expect(ran).toBe(false);
    } finally {
      await env.DB.prepare("ALTER TABLE audit_log_off RENAME TO audit_log").run();
    }
  });

  it("rejects an unknown action", async () => {
    await expect(recorder(null).write({ action: "nope" as never, outcome: "succeeded" })).rejects.toBeInstanceOf(AuditWriteError);
  });
});
```

- [ ] **Step 7: Run it**

Run: `cd apps/worker && npx vitest run test/audit-recorder.test.ts && npm test`
Expected: 5 passed; full suite passes.

- [ ] **Step 8: Commit**

```bash
git add packages/audit apps/worker/package.json package-lock.json apps/worker/test/audit-recorder.test.ts
aramid check --staged
git commit -m "feat(audit): @repo/audit package - catalogue, canonical hashing, allow-lists, recorder"
```

---

### Task 4: Worker glue, request ids and the runtime gap guard

**Files:**
- Create: `apps/worker/src/audit/context.ts`, `apps/worker/src/audit/gap-guard.ts`
- Modify: `apps/worker/src/index.ts` (register middleware; export `app` and `stripeWebhookApp`)
- Test: `apps/worker/test/audit-gap-guard.test.ts`

**Interfaces:**
- Consumes: `createAuditRecorder`, `AuditWriteError`, `AuditEntryInput` from `@repo/audit`.
- Produces: `auditFor(c, via?)`, `systemAudit(db, via, requestId?)`, `batchWithAudit(c, changes, input): Promise<Response | null>`, `auditRefused(c)`, `AUDIT_REFUSED_MESSAGE`, `WORKER_NAME`, `auditGapGuard`; named exports `app` and `stripeWebhookApp` from `src/index.ts`.

- [ ] **Step 1: Write the failing test**

`apps/worker/test/audit-gap-guard.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";

describe("audit gap guard", () => {
  it("records an audit.gap entry for an un-instrumented mutating request", async () => {
    const res = await dispatch("POST", "/api/contact", {
      headers: { "CF-Connecting-IP": "192.0.2.10" },
      body: { full_name: "Gap Test", shop_name: "Gap", shop_type: "barber_shop", email: "gap@test.local", message: "hi" },
    });
    const row = await env.DB.prepare(
      "SELECT action, outcome, details_json, actor_type, ip_ref FROM audit_log WHERE action = 'audit.gap' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ action: string; outcome: string; details_json: string; actor_type: string; ip_ref: string | null }>();
    expect(row, `no gap entry; contact returned ${res.status}`).not.toBeNull();
    expect(JSON.parse(row!.details_json)).toMatchObject({ method: "POST", path: "/api/contact", status: res.status });
    expect(row!.actor_type).toBe("anonymous");
    expect(row!.ip_ref).not.toBeNull();
  });

  it("skips GET requests and unmatched paths", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.gap'").first<{ n: number }>();
    await dispatch("GET", "/health");
    await dispatch("POST", "/definitely/not/a/route");
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.gap'").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("gives every request an id", async () => {
    const res = await dispatch("GET", "/health");
    expect(res.headers.get("X-Request-Id")).toMatch(/.+/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/audit-gap-guard.test.ts`
Expected: FAIL, "no gap entry".

- [ ] **Step 3: Write the glue**

`apps/worker/src/audit/context.ts`:

```ts
import type { Context } from "hono";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  AuditWriteError,
  createAuditRecorder,
  type ActorType,
  type AuditActor,
  type AuditEntryInput,
  type AuditRecorder,
  type Via,
} from "@repo/audit";
import type { Bindings } from "../bindings.js";
import type { JWTUser } from "../middleware/auth.js";

declare module "hono" {
  interface ContextVariableMap {
    auditWritten: boolean;
  }
}

export const WORKER_NAME = "pivot-parlor-api";
export const AUDIT_REFUSED_MESSAGE = "Could not record this action; nothing was changed.";

const ROLE_TO_ACTOR: Record<string, ActorType> = {
  developer: "developer",
  admin: "admin",
  staff: "staff",
  customer: "customer",
};

type Ctx = Context<{ Bindings: Bindings }>;

export function actorFrom(c: Ctx): AuditActor {
  const user = c.get("user") as JWTUser | undefined;
  const ip = c.req.header("CF-Connecting-IP") ?? null;
  if (!user) return { type: "anonymous", ip };
  return {
    type: ROLE_TO_ACTOR[user.role] ?? "anonymous",
    userId: user.sub,
    role: user.role,
    shopId: user.shop_id ?? null,
    ip,
  };
}

export function auditFor(c: Ctx, via: Via = "api"): AuditRecorder {
  return createAuditRecorder({
    db: c.env.DB,
    worker: WORKER_NAME,
    via,
    actor: actorFrom(c),
    requestId: c.get("requestId") ?? null,
    onWrite: () => c.set("auditWritten", true),
  });
}

export function systemAudit(db: D1Database, via: Via, requestId: string | null = null): AuditRecorder {
  return createAuditRecorder({ db, worker: WORKER_NAME, via, actor: { type: "system" }, requestId });
}

export function auditRefused(c: Ctx): Response {
  return c.json({ success: false, error: AUDIT_REFUSED_MESSAGE }, 503);
}

/** Commit `changes` and the audit entry in ONE batch (all-or-nothing).
 *  Returns a 503 Response when the entry cannot be prepared, else null. */
export async function batchWithAudit(
  c: Ctx,
  changes: D1PreparedStatement[],
  input: AuditEntryInput
): Promise<Response | null> {
  let audit: D1PreparedStatement[];
  try {
    audit = await auditFor(c).statements(input);
  } catch (err) {
    if (err instanceof AuditWriteError) return auditRefused(c);
    throw err;
  }
  await c.env.DB.batch([...changes, ...audit]);
  return null;
}
```

`apps/worker/src/audit/gap-guard.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../bindings.js";
import { auditFor } from "./context.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Floor entry for any state-changing request that finished without writing
 * its own audit entry (Plan 1 decision 2). Best effort, written after the
 * response is built; the instrumented routes are the real guarantee.
 */
export const auditGapGuard: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  await next();
  if (!MUTATING.has(c.req.method) || c.get("auditWritten")) return;
  const status = c.res.status;
  if (status === 404 || status === 405) return;
  const outcome = status >= 500 ? "failed" : status >= 400 ? "refused" : "succeeded";
  try {
    await auditFor(c).write({
      action: "audit.gap",
      outcome,
      details: { method: c.req.method, path: c.req.path, status },
    });
  } catch (err) {
    console.error("[audit] gap entry could not be written", c.req.method, c.req.path, err);
  }
};
```

- [ ] **Step 4: Register it in `src/index.ts`**

Add imports next to the other middleware imports:

```ts
import { requestId } from "hono/request-id";
import { auditGapGuard } from "./audit/gap-guard.js";
```

Directly after the `stripeWebhookApp` is created and BEFORE its `.route(...)` line, change to:

```ts
const stripeWebhookApp = new Hono<{ Bindings: Bindings }>();
stripeWebhookApp.use("*", requestId(), auditGapGuard);
stripeWebhookApp.route("/api/webhooks", webhooksRouter);
```

Directly after the `app.use("*", cors({...}))` block, add:

```ts
// Audit trail: every request gets an id; state-changing requests that write
// no audit entry of their own leave an audit.gap floor entry.
app.use("*", requestId(), auditGapGuard);
```

Before `export default {`, add:

```ts
// Exported for the audit coverage test (test/audit-coverage.test.ts).
export { app, stripeWebhookApp };
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/worker && npx vitest run test/audit-gap-guard.test.ts && npm test && npx tsc --noEmit`
Expected: 3 passed; full suite passes; tsc clean. If an existing test counts KV/D1 writes on a POST and now sees extra rows, the count assertion is on its own tables; `audit_*` rows do not affect it. Report any existing test that fails rather than editing it.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/audit apps/worker/src/index.ts apps/worker/test/audit-gap-guard.test.ts
aramid check --staged
git commit -m "feat(audit): request ids, audit context helpers and the runtime gap guard"
```

---

### Task 5: Coverage registry and ratchet

**Files:**
- Create: `apps/worker/src/audit/registry.ts`
- Test: `apps/worker/test/audit-coverage.test.ts`

**Interfaces:**
- Consumes: `app`, `stripeWebhookApp` (Task 4), `isAuditAction` (Task 3).
- Produces: `ROUTE_AUDIT`, `CRON_AUDIT`, `QUEUE_AUDIT`, `PENDING_CEILING`. Plans 2 and 3 replace `"pending"` values with actions and lower `PENDING_CEILING`.

- [ ] **Step 1: Write the failing test**

`apps/worker/test/audit-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isAuditAction } from "@repo/audit";
import { app, stripeWebhookApp } from "../src/index";
import { CRON_AUDIT, PENDING_CEILING, QUEUE_AUDIT, ROUTE_AUDIT, type AuditDeclaration } from "../src/audit/registry";
import wranglerToml from "../wrangler.toml?raw";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function mutatingRoutes(): string[] {
  const all = [...app.routes, ...stripeWebhookApp.routes];
  return [...new Set(all.filter((r) => MUTATING.has(r.method)).map((r) => `${r.method} ${r.path}`))].sort();
}

function tomlList(re: RegExp): string[] {
  return [...new Set([...wranglerToml.matchAll(re)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!)))];
}

const crons = tomlList(/crons\s*=\s*\[([^\]]*)\]/g);
const queues = [...new Set([...wranglerToml.matchAll(/queues\.consumers\]\]\s*\nqueue\s*=\s*("[^"]+")/g)].map((m) => JSON.parse(m[1]!) as string))];

function valid(d: AuditDeclaration): boolean {
  return d === "pending" || (typeof d === "object" && typeof d.exempt === "string" && d.exempt.length > 10) || isAuditAction(d);
}

describe("audit coverage", () => {
  it("every mutating route declares its audit action", () => {
    expect(mutatingRoutes().filter((k) => !(k in ROUTE_AUDIT))).toEqual([]);
  });

  it("the route registry has no stale entries", () => {
    const live = new Set(mutatingRoutes());
    expect(Object.keys(ROUTE_AUDIT).filter((k) => !live.has(k))).toEqual([]);
  });

  it("every cron schedule and queue consumer is declared", () => {
    expect(crons.length).toBeGreaterThan(0);
    expect(queues.length).toBeGreaterThan(0);
    expect(crons.filter((c) => !(c in CRON_AUDIT))).toEqual([]);
    expect(queues.filter((q) => !(q in QUEUE_AUDIT))).toEqual([]);
  });

  it("every declaration is a catalogue action, pending, or a reasoned exemption", () => {
    const bad = Object.entries({ ...ROUTE_AUDIT, ...CRON_AUDIT, ...QUEUE_AUDIT }).filter(([, d]) => !valid(d));
    expect(bad).toEqual([]);
  });

  it("the pending count matches the ratchet", () => {
    const pending = [...Object.values(ROUTE_AUDIT), ...Object.values(CRON_AUDIT), ...Object.values(QUEUE_AUDIT)].filter(
      (d) => d === "pending"
    ).length;
    expect(pending, "Lower PENDING_CEILING in src/audit/registry.ts when you instrument something; never raise it").toBe(
      PENDING_CEILING
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/audit-coverage.test.ts`
Expected: FAIL, cannot resolve `../src/audit/registry`.

- [ ] **Step 3: Write the registry**

`apps/worker/src/audit/registry.ts` (the 70 routes were extracted from `app.routes` on 2026-09-26; `/api/audit` routes are added by Task 11 and listed here already):

```ts
import type { AuditAction } from "@repo/audit";

/** An action from the catalogue, "pending" (not yet instrumented; the gap
 *  guard still records an audit.gap entry), or a reasoned exemption. */
export type AuditDeclaration = AuditAction | "pending" | { exempt: string };

export const ROUTE_AUDIT: Record<string, AuditDeclaration> = {
  // Instrumented in Plan 1
  "DELETE /api/shops/:shopId": "shop.delete",
  "POST /api/shops/:shopId/delete": "shop.delete",
  "POST /api/shops/:shopId/activate": "site.activate",
  "POST /api/shops/:shopId/pause": "site.pause",
  "POST /api/shops/:shopId/generate-site": "site.regenerate.request",
  "POST /api/ai/apply-theme": "theme.apply",
  "POST /api/ai/chatbot-model": "ai.chatbot_model.set",
  "POST /api/ai/compare": "theme.compare",
  "POST /api/ai/generate-theme": "theme.generate",
  // Task 11 adds the three /api/audit POST routes here.

  // Plan 2
  "DELETE /api/shops/:shopId/products/:productId": "pending",
  "DELETE /api/shops/:shopId/products/:productId/variants/:variantId": "pending",
  "DELETE /api/shops/:shopId/services/:serviceId": "pending",
  "DELETE /api/shops/:shopId/staff/:staffId": "pending",
  "DELETE /api/shops/:shopId/walkin": "pending",
  "PATCH /api/me/profile": "pending",
  "PATCH /api/shops/:shopId": "pending",
  "PATCH /api/shops/:shopId/settings": "pending",
  "PATCH /api/shops/:shopId/walkin/:entryId": "pending",
  "PATCH /api/waitlist/:id/status": "pending",
  "POST /api/bookings": "pending",
  "POST /api/bookings/:bookingId/abandon": "pending",
  "POST /api/contact": "pending",
  "POST /api/invites/:token/accept": "pending",
  "POST /api/me/bookings/:bookingId/cancel": "pending",
  "POST /api/shops": "pending",
  "POST /api/shops/:shopId/generate-image": "pending",
  "POST /api/shops/:shopId/inventory/movements": "pending",
  "POST /api/shops/:shopId/products": "pending",
  "POST /api/shops/:shopId/products/:productId/variants": "pending",
  "POST /api/shops/:shopId/products/categories": "pending",
  "POST /api/shops/:shopId/purchase-orders": "pending",
  "POST /api/shops/:shopId/purchase-orders/:poId/cancel": "pending",
  "POST /api/shops/:shopId/purchase-orders/:poId/order": "pending",
  "POST /api/shops/:shopId/purchase-orders/:poId/receive": "pending",
  "POST /api/shops/:shopId/remove-image": "pending",
  "POST /api/shops/:shopId/reviews": "pending",
  "POST /api/shops/:shopId/save-image": "pending",
  "POST /api/shops/:shopId/services": "pending",
  "POST /api/shops/:shopId/settings": "pending",
  "POST /api/shops/:shopId/staff": "pending",
  "POST /api/shops/:shopId/staff/:staffId/avatar": "pending",
  "POST /api/shops/:shopId/stock-takes": "pending",
  "POST /api/shops/:shopId/stock-takes/:stockTakeId/cancel": "pending",
  "POST /api/shops/:shopId/stock-takes/:stockTakeId/complete": "pending",
  "POST /api/shops/:shopId/suppliers": "pending",
  "POST /api/shops/:shopId/upload-image": "pending",
  "POST /api/staff/me/time-off": "pending",
  "POST /api/waitlist": "pending",
  "POST /api/waitlist/:id/notify": "pending",
  "POST /api/walkin/:shopSlug/join": "pending",
  "POST /api/webhooks/stripe": "pending",
  "POST /auth/login": "pending",
  "POST /auth/logout": "pending",
  "POST /auth/register": "pending",
  "POST /auth/resend-verification": "pending",
  "POST /auth/verify-email": "pending",
  "POST /contact": "pending",
  "PUT /api/shops/:shopId/bookings/:bookingId/status": "pending",
  "PUT /api/shops/:shopId/inventory/reorder": "pending",
  "PUT /api/shops/:shopId/products/:productId": "pending",
  "PUT /api/shops/:shopId/products/:productId/variants/:variantId": "pending",
  "PUT /api/shops/:shopId/products/categories/:categoryId": "pending",
  "PUT /api/shops/:shopId/purchase-orders/:poId": "pending",
  "PUT /api/shops/:shopId/schedule": "pending",
  "PUT /api/shops/:shopId/services/:serviceId": "pending",
  "PUT /api/shops/:shopId/services/:serviceId/products": "pending",
  "PUT /api/shops/:shopId/staff/:staffId": "pending",
  "PUT /api/shops/:shopId/stock-takes/:stockTakeId/items": "pending",
  "PUT /api/shops/:shopId/suppliers/:supplierId": "pending",
  "PUT /api/staff/me/bookings/:bookingId/status": "pending",
};

export const CRON_AUDIT: Record<string, AuditDeclaration> = {
  "* * * * *": { exempt: "audit infrastructure: the sealer only fills the one-time sealing columns" },
  "0 3 * * *": "pending",
  "0 8 * * *": "pending",
  "0 20 * * *": "pending",
};

export const QUEUE_AUDIT: Record<string, AuditDeclaration> = {
  "pivot-parlor-reminders": "pending",
  "pivot-parlor-reminders-staging": "pending",
};

/** Ratchet: only ever lowered (Plans 2 and 3 bring it to 0). */
export const PENDING_CEILING = 66;
```

- [ ] **Step 4: Run it**

Run: `cd apps/worker && npx vitest run test/audit-coverage.test.ts && npm test`
Expected: 5 passed; full suite passes. (The registry already declares the `"* * * * *"` cron Task 8 adds; the test only requires every toml cron to be declared, so an extra declaration is fine.)

If the "every mutating route" test lists a route this plan did not anticipate, the route list changed after 2026-09-26: add it as `"pending"`, raise nothing else, and set `PENDING_CEILING` to the new true count in the same commit, noting it in the report.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/audit/registry.ts apps/worker/test/audit-coverage.test.ts
aramid check --staged
git commit -m "test(audit): coverage registry for every mutating route, cron and queue, with a ratchet"
```

---

### Task 6: Instrument site activate, pause, delete and regenerate

**Files:**
- Modify: `apps/worker/src/db/queries.ts` (add `shopSiteWebsiteStatusStatement`, around line 683)
- Modify: `apps/worker/src/routes/shops.ts` (`deleteShopDeveloper` ~1069, `/activate` ~1112, `/pause` ~1123, `/generate-site` ~1134)
- Test: `apps/worker/test/audit-site-routes.test.ts`

**Interfaces:**
- Consumes: `auditFor`, `batchWithAudit`, `auditRefused` (Task 4); `AuditWriteError`, `userSubjectId` (Task 3).
- Produces: queue payload field `origin_actor_ref: string | null` on `site_research_queue` messages (consumed in Plan 3).

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/audit-site-routes.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedShop, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";

async function devToken() {
  const id = await seedUser("developer", null);
  return { id, token: await tokenFor(id, "developer", null) };
}

async function seedSite(shopId: string, status: string) {
  await env.DB.prepare(
    "INSERT INTO shop_sites (id, shop_id, template, status, website_status) VALUES (?, ?, 'minimal', 'active', ?)"
  ).bind(crypto.randomUUID(), shopId, status).run();
}

const entriesFor = (shopId: string, action: string) =>
  env.DB.prepare("SELECT * FROM audit_log WHERE shop_id = ? AND action = ? ORDER BY occurred_at")
    .bind(shopId, action)
    .all<Record<string, unknown>>()
    .then((r) => r.results ?? []);

describe("site routes are audited", () => {
  it("pause records who, what changed, and no gap entry", async () => {
    const { id, token } = await devToken();
    const shopId = await seedShop("Pause Shop");
    await seedSite(shopId, "live");
    const res = await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const [e] = await entriesFor(shopId, "site.pause");
    expect(e).toMatchObject({ outcome: "succeeded", actor_type: "developer", actor_ref: `subj_user_${id}`, phase: "done" });
    expect(JSON.parse(e!.changes_json as string)).toEqual({ website_status: ["live", "paused"] });
    const gaps = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.gap' AND request_id = ?")
      .bind(e!.request_id).first<{ n: number }>();
    expect(gaps!.n).toBe(0);
  });

  it("activate records live", async () => {
    const { token } = await devToken();
    const shopId = await seedShop("Activate Shop");
    await seedSite(shopId, "paused");
    await dispatch("POST", `/api/shops/${shopId}/activate`, { headers: authHeaders(token) });
    const [e] = await entriesFor(shopId, "site.activate");
    expect(JSON.parse(e!.changes_json as string)).toEqual({ website_status: ["paused", "live"] });
  });

  it("pause changes nothing when the audit entry cannot be written", async () => {
    const { token } = await devToken();
    const shopId = await seedShop("Atomic Shop");
    await seedSite(shopId, "live");
    await env.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_off").run();
    try {
      const res = await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await env.DB.prepare("ALTER TABLE audit_log_off RENAME TO audit_log").run();
    }
    const site = await env.DB.prepare("SELECT website_status FROM shop_sites WHERE shop_id = ?").bind(shopId).first<{ website_status: string }>();
    expect(site!.website_status).toBe("live");
  });

  it("delete records started + succeeded and schedules blanking for the shop's subjects", async () => {
    const { token } = await devToken();
    const shopId = await seedShop("Delete Shop");
    // A subject id only; no platform_users row, so the shop delete is not blocked by a foreign key.
    const adminId = `u-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO audit_subjects (id, kind, user_id, shop_id, email, created_at) VALUES (?, 'user', ?, ?, 'a@test.local', ?)")
      .bind(`subj_user_${adminId}`, adminId, shopId, new Date().toISOString()).run();
    const res = await dispatch("POST", `/api/shops/${shopId}/delete`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const rows = await entriesFor(shopId, "shop.delete");
    expect(rows.map((r) => [r.phase, r.outcome])).toEqual([["started", null], ["outcome", "succeeded"]]);
    const subj = await env.DB.prepare("SELECT redact_after FROM audit_subjects WHERE id = ?").bind(`subj_user_${adminId}`).first<{ redact_after: string }>();
    expect(Date.parse(subj!.redact_after)).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
  });

  it("generate-site records failed with the status when it returns an error Response", async () => {
    const { token } = await devToken();
    const shopId = await seedShop("Regen Shop");
    // The test worker has no site_research_queue binding, so the handler returns 503.
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, { headers: authHeaders(token), body: {} });
    expect(res.status).toBe(503);
    const rows = await entriesFor(shopId, "site.regenerate.request");
    const outcome = rows.find((r) => r.phase === "outcome")!;
    expect(outcome).toMatchObject({ outcome: "failed", reason: "HTTP 503" });
    expect(JSON.parse(outcome.details_json as string)).toHaveProperty("job_id");
  });
});
```

Before relying on the `shop_sites` insert, confirm its NOT NULL columns in `schema.sql` (`grep -n "CREATE TABLE IF NOT EXISTS shop_sites" -A30 apps/worker/src/db/schema.sql`) and add any missing required column to `seedSite`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/audit-site-routes.test.ts`
Expected: FAIL; no `site.pause` entry (only `audit.gap`).

- [ ] **Step 3: Add the statement builder to `queries.ts`**

Replace the body of `updateShopSiteWebsiteStatus` (around line 683) with a statement builder plus the old wrapper:

```ts
/** Prepared (unexecuted) website_status update, for batching with an audit entry. */
export function shopSiteWebsiteStatusStatement(db: D1Database, shopId: string, websiteStatus: string) {
  return db
    .prepare("UPDATE shop_sites SET website_status = ? WHERE shop_id = ? AND status = 'active'")
    .bind(websiteStatus, shopId);
}

export function updateShopSiteWebsiteStatus(db: D1Database, shopId: string, websiteStatus: string) {
  return shopSiteWebsiteStatusStatement(db, shopId, websiteStatus).run();
}
```

- [ ] **Step 4: Instrument the routes in `shops.ts`**

Add to the imports:

```ts
import { AuditWriteError, userSubjectId } from "@repo/audit";
import { auditFor, auditRefused, batchWithAudit } from "../audit/context.js";
```

and add `shopSiteWebsiteStatusStatement` to the existing `../db/queries.js` import list.

Replace the `/activate` and `/pause` handlers with:

```ts
async function changeWebsiteStatus(
  c: Context<{ Bindings: Bindings }>,
  status: "live" | "paused",
  action: "site.activate" | "site.pause"
) {
  const param = c.req.param("shopId");
  if (!param) return c.json({ success: false, error: "Missing shop id" }, 400);
  const shop = (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  const site = await c.env.DB.prepare(
    "SELECT website_status FROM shop_sites WHERE shop_id = ? AND status = 'active' LIMIT 1"
  )
    .bind(shop.id)
    .first<{ website_status: string | null }>();
  const refused = await batchWithAudit(c, [shopSiteWebsiteStatusStatement(c.env.DB, shop.id, status)], {
    action,
    outcome: "succeeded",
    shopId: shop.id,
    entityType: "shop_site",
    entityId: shop.id,
    changes: { website_status: [site?.website_status ?? null, status] },
    details: site ? null : { no_site_row: true },
  });
  if (refused) return refused;
  return c.json({ ok: true });
}

// ─── POST /api/shops/:shopId/activate — developer only ───
shops.post("/:shopId/activate", authMiddleware, requireRole("developer"), (c) =>
  changeWebsiteStatus(c, "live", "site.activate")
);

// ─── POST /api/shops/:shopId/pause — developer only ───
shops.post("/:shopId/pause", authMiddleware, requireRole("developer"), (c) =>
  changeWebsiteStatus(c, "paused", "site.pause")
);
```

In `deleteShopDeveloper`, wrap the body of the existing `try { ... }` (everything from the first `DELETE FROM generation_jobs` through `return c.json({ success: true, ... })`) so it becomes:

```ts
  try {
    await auditFor(c).run(
      {
        action: "shop.delete",
        shopId: shop.id,
        entityType: "shop",
        entityId: shop.id,
        details: { slug: shop.slug, name: shop.name },
      },
      async () => {
        // Spec 6.2: personal details of this shop's people are blanked 30 days after it leaves.
        const redactAfter = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
        await c.env.DB.prepare(
          "UPDATE audit_subjects SET redact_after = ? WHERE shop_id = ? AND redacted_at IS NULL"
        )
          .bind(redactAfter, shop.id)
          .run();
        /* ...the existing DELETE/UPDATE/KV statements, unchanged, in their existing order... */
      }
    );
    return c.json({ success: true, data: { id: shop.id } });
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    console.error("[shops.delete]", e);
    const msg = e instanceof Error ? e.message : "Delete failed";
    return c.json({ success: false, error: msg }, 500);
  }
```

(Move the existing statements into the inner function verbatim; the `return c.json({ success: true ...})` moves after `run`.)

In `/generate-site`, find the line `let jobId: string | null = null;` and the `try {` that follows it. Wrap from that `try` to the end of its matching `catch` block in a run whose function returns the Response:

```ts
  let jobId: string | null = null;
  const nowKv = () => /* unchanged */;

  try {
    return await auditFor(c).run(
      {
        action: "site.regenerate.request",
        shopId: shop.id,
        entityType: "shop_site",
        entityId: shop.id,
        details: {
          text_model: bodyText || null,
          image_model: bodyImage || null,
          skip_images: body.skip_images === true,
          composer: bodyComposerRaw || null,
          template: typeof body.template === "string" ? body.template : null,
        },
      },
      async (): Promise<Response> => {
        /* the existing `try { ... } catch (err) { ... }` block, unchanged,
           EXCEPT the queue payload gains one field: */
      },
      (res) => ({
        outcome: res.status < 400 ? "succeeded" : "failed",
        reason: res.status < 400 ? null : `HTTP ${res.status}`,
        details: { job_id: jobId },
      })
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
```

Inside the moved block, add to `queuePayload` (after `composer,`):

```ts
      origin_actor_ref: user.sub ? userSubjectId(user.sub) : null,
```

Check that `Context` is imported from `hono` in `shops.ts` (it is used by `deleteShopDeveloper`'s signature); if not, add `import type { Context } from "hono";`.

- [ ] **Step 5: Run the tests**

Run: `cd apps/worker && npx vitest run test/audit-site-routes.test.ts && npm test && npx tsc --noEmit`
Expected: 5 passed; full suite passes (`generate-site.*.test.ts` still pass: the Response they assert on is unchanged); tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/db/queries.ts apps/worker/src/routes/shops.ts apps/worker/test/audit-site-routes.test.ts
aramid check --staged
git commit -m "feat(audit): record site activate/pause/delete/regenerate with before/after and refusal"
```

---

### Task 7: Instrument the AI routes, and stop mislabelling fallback themes

**Files:**
- Modify: `apps/worker/src/services/ai-generator.ts` (`callThemeModel` ~112, `generateShopTheme`, `persistShopTheme` ~142)
- Modify: `apps/worker/src/routes/ai.ts` (`/chatbot-model`, `/generate-theme`, `/apply-theme`, `/compare`)
- Test: `apps/worker/test/audit-ai-routes.test.ts`

**Interfaces:**
- Consumes: `AuditRecorder` (Task 3), `auditFor`, `auditRefused` (Task 4).
- Produces: `ThemeGenerationOptions.audit?: AuditRecorder`; `persistShopTheme(db, kv, shopId, modelId, config, audit?: ThemeAudit)`; `generateShopTheme` result is unchanged (`BrandConfig`).

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/audit-ai-routes.test.ts`:

```ts
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authHeaders, seedShop, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";

async function dev() {
  const id = await seedUser("developer", null);
  return tokenFor(id, "developer", null);
}

const byAction = (action: string) =>
  env.DB.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY occurred_at")
    .bind(action)
    .all<Record<string, unknown>>()
    .then((r) => r.results ?? []);

afterEach(() => vi.restoreAllMocks());

describe("AI routes are audited", () => {
  it("chatbot-model records the old and new model", async () => {
    const token = await dev();
    const models = await dispatch("GET", "/api/ai/models", { headers: authHeaders(token) });
    const listed = ((await models.json()) as { data: { id: string; kind?: string }[] }).data.find((m) => !m.id.includes("image"))!;
    await dispatch("POST", "/api/ai/chatbot-model", { headers: authHeaders(token), body: { model_id: listed.id } });
    const outcome = (await byAction("ai.chatbot_model.set")).find((r) => r.phase === "outcome")!;
    expect(outcome.outcome).toBe("succeeded");
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ chatbot_model: [null, listed.id] });
  });

  it("apply-theme commits the theme and its entry together", async () => {
    const token = await dev();
    const shopId = await seedShop("Theme Shop");
    const theme = {
      primaryColor: "#111111", accentColor: "#222222", fontHeading: "Playfair Display", fontBody: "DM Sans",
      tagline: "t", heroHeadline: "h", heroSubheadline: "s", shortDescription: "d", ctaText: "c",
      aestheticKeywords: [], servicesIntro: "i",
    };
    const res = await dispatch("POST", "/api/ai/apply-theme", { headers: authHeaders(token), body: { shop_id: shopId, theme, model_id: "openai-api/gpt-6-astra" } });
    expect(res.status, await res.clone().text()).toBe(200);
    const e = (await byAction("theme.apply")).find((r) => r.shop_id === shopId)!;
    expect(JSON.parse(e.changes_json as string)).toMatchObject({ ai_model: [null, "openai-api/gpt-6-astra"], primaryColor: [null, "#111111"] });
  });

  it("generate-theme records ai.call as failed and flags the fallback theme", async () => {
    const token = await dev();
    const shopId = await seedShop("Fallback Shop");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const res = await dispatch("POST", "/api/ai/generate-theme", { headers: authHeaders(token), body: { shop_id: shopId, regenerate: true } });
    expect(res.status).toBe(200);
    const call = (await byAction("ai.call")).filter((r) => r.shop_id === shopId && r.phase === "outcome");
    expect(call[0]).toMatchObject({ outcome: "failed" });
    const applied = (await byAction("theme.apply")).find((r) => r.shop_id === shopId)!;
    expect(JSON.parse(applied.details_json as string)).toMatchObject({ fallback: true });
  });
});
```

Before running, check `validateBrandConfig` in `ai-generator.ts` and adjust the `theme` fixture so it passes validation (copy the field list from the `BrandConfig` interface at line 7). If `/api/ai/models` in the test environment lists no text model, take the id from `test/setup-model-registry.ts` instead.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker && npx vitest run test/audit-ai-routes.test.ts`
Expected: FAIL; no `ai.chatbot_model.set` entry.

- [ ] **Step 3: Change the generator**

In `ai-generator.ts`, add to the imports:

```ts
import type { AuditRecorder } from "@repo/audit";
```

Extend the options interface:

```ts
export interface ThemeGenerationOptions {
  palette?: ThemePalette;
  persist?: boolean;
  /** When set, the vendor call and the persisted theme are audited. */
  audit?: AuditRecorder;
}
```

Change `callThemeModel` to return the call metadata instead of only the config. Its final lines become:

```ts
  console.log(
    `[AI Generator] llm route=${result.route} model=${result.model} in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"}`
  );
  return {
    config: JSON.parse(result.text) as BrandConfig,
    route: result.route,
    model: result.model,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
  };
```

and its declared return type becomes `Promise<{ config: BrandConfig; route: string; model: string; inputTokens: number | null; outputTokens: number | null }>`.

In `generateShopTheme`, replace the `try { ... } catch { ... }` around `callThemeModel` and the persist block with:

```ts
  let config: BrandConfig;
  let fallback = false;
  const effectiveEffort = model.supportsEffort ? effort : undefined;
  const call = () => callThemeModel(modelId, prompt, keys, effectiveEffort);
  try {
    const result = options.audit
      ? await options.audit.run(
          { action: "ai.call", shopId, entityType: "shop", entityId: shopId, details: { purpose: "theme", model: modelId } },
          call,
          (r) => ({
            details: {
              purpose: "theme",
              model: r.model,
              route: r.route,
              input_tokens: r.inputTokens,
              output_tokens: r.outputTokens,
              estimated_cost_usd:
                r.inputTokens !== null && r.outputTokens !== null
                  ? (r.inputTokens * model.costPer1MInput + r.outputTokens * model.costPer1MOutput) / 1_000_000
                  : null,
            },
          })
        )
      : await call();
    config = result.config;
  } catch (err) {
    if (err instanceof Error && err.name === "AuditWriteError") throw err;
    console.error(`[AI Generator] ${model.provider} call failed, using fallback:`, err);
    config = defaultTheme(shopName, shopType);
    fallback = true;
  }

  if (options.palette) {
    config.primaryColor = options.palette.primary;
    config.accentColor = options.palette.accent;
  }

  if (options.persist !== false) {
    await persistShopTheme(db, kv, shopId, modelId, config, options.audit ? { recorder: options.audit, fallback } : undefined);
  }

  return config;
```

(If `model` has no `costPer1MInput`/`costPer1MOutput` fields on its type, check `getModel`'s return type in `model-registry.ts` and use its price field names.)

Replace `persistShopTheme` with:

```ts
export interface ThemeAudit {
  recorder: AuditRecorder;
  fallback: boolean;
}

const THEME_AUDIT_KEYS = ["primaryColor", "accentColor", "fontHeading", "fontBody", "heroHeadline", "tagline"] as const;

/** Write a theme to the shop row and the KV cache — the single "apply" path.
 *  With `audit`, the row update and its theme.apply entry commit together. */
export async function persistShopTheme(
  db: D1Database,
  kv: KVNamespace,
  shopId: string,
  modelId: string,
  config: BrandConfig,
  audit?: ThemeAudit
): Promise<void> {
  const update = db
    .prepare("UPDATE shops SET ai_theme = ?, ai_model = ? WHERE id = ?")
    .bind(JSON.stringify(config), modelId, shopId);
  let auditStmts: D1PreparedStatement[] = [];
  if (audit) {
    const prev = await db
      .prepare("SELECT ai_theme, ai_model FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ ai_theme: string | null; ai_model: string | null }>();
    const before = (safeJsonParse(prev?.ai_theme ?? null) ?? {}) as Partial<BrandConfig>;
    const changes: Record<string, [unknown, unknown]> = { ai_model: [prev?.ai_model ?? null, modelId] };
    for (const k of THEME_AUDIT_KEYS) changes[k] = [before[k] ?? null, config[k] ?? null];
    auditStmts = await audit.recorder.statements({
      action: "theme.apply",
      outcome: "succeeded",
      shopId,
      entityType: "theme",
      entityId: shopId,
      changes,
      details: { model: modelId, fallback: audit.fallback },
    });
  }
  await db.batch([update, ...auditStmts]);
  await kv.put(`shop:theme:${shopId}`, JSON.stringify(config), { expirationTtl: THEME_KV_TTL });
}
```

Add `D1PreparedStatement` to the existing `@cloudflare/workers-types` type import and `safeJsonParse` from `@repo/utils` if not already imported.

- [ ] **Step 4: Change the routes in `ai.ts`**

Add imports:

```ts
import { AuditWriteError } from "@repo/audit";
import { auditFor, auditRefused } from "../audit/context.js";
```

`POST /chatbot-model`, replace the two lines after `if (!model) ...`:

```ts
  const record = { model_id: modelId, updated_at: new Date().toISOString() };
  const previous = safeJsonParse<{ model_id?: unknown }>(await c.env.KV.get(CHATBOT_MODEL_KV_KEY));
  try {
    await auditFor(c).run(
      {
        action: "ai.chatbot_model.set",
        entityType: "platform_setting",
        entityId: "chatbot_model",
        changes: { chatbot_model: [typeof previous?.model_id === "string" ? previous.model_id : null, modelId] },
      },
      () => c.env.KV.put(CHATBOT_MODEL_KV_KEY, JSON.stringify(record))
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
  return c.json({ success: true, data: record });
```

`POST /generate-theme`: the cached branch writes a plain entry, the generation branch runs inside `theme.generate`. Replace from `if (!body.regenerate) {` to the final `return` with:

```ts
  const audit = auditFor(c);
  try {
    if (!body.regenerate) {
      const cached = safeJsonParse(await c.env.KV.get(`shop:theme:${shop.id}`)) ?? safeJsonParse(shop.ai_theme);
      if (cached) {
        await audit.write({ action: "theme.generate", outcome: "succeeded", shopId: shop.id, entityType: "theme", entityId: shop.id, details: { cached: true, model: modelId } });
        return c.json({ success: true, data: cached, cached: true, model_used: modelId });
      }
    }
    const theme = await audit.run(
      { action: "theme.generate", shopId: shop.id, entityType: "theme", entityId: shop.id, details: { model: modelId, preview: body.preview === true } },
      () =>
        generateShopTheme(shop.id, shop.name, shop.type, modelId, body.style_keywords, effort, c.env.DB, c.env.KV, providerKeysFromEnv(c.env), {
          palette: parsePalette(body),
          persist: body.preview !== true,
          audit,
        })
    );
    return c.json({ success: true, data: theme, cached: false, model_used: modelId });
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
```

`POST /apply-theme`, replace the `persistShopTheme(...)` line:

```ts
  try {
    await persistShopTheme(c.env.DB, c.env.KV, shop.id, modelId, theme, { recorder: auditFor(c), fallback: false });
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
```

`POST /compare`: pass `audit` into both calls and wrap the pair:

```ts
  const audit = auditFor(c);
  const options = { palette: parsePalette(body), persist: false as const, audit };
  let resultA: PromiseSettledResult<BrandConfig>;
  let resultB: PromiseSettledResult<BrandConfig>;
  try {
    [resultA, resultB] = await audit.run(
      { action: "theme.compare", shopId: shop.id, entityType: "theme", entityId: shop.id, details: { model_a: body.model_a_id, model_b: body.model_b_id } },
      () =>
        Promise.allSettled([
          generateShopTheme(shop.id, shop.name, shop.type, body.model_a_id!, body.style_keywords, effort, c.env.DB, c.env.KV, providerKeysFromEnv(c.env), options),
          generateShopTheme(shop.id, shop.name, shop.type, body.model_b_id!, body.style_keywords, effort, c.env.DB, c.env.KV, providerKeysFromEnv(c.env), options),
        ])
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
```

(then the existing `return c.json({ ... model_a / model_b ... })` unchanged). Import `BrandConfig` as a type from `../services/ai-generator.js` if needed.

- [ ] **Step 5: Run the tests**

Run: `cd apps/worker && npx vitest run test/audit-ai-routes.test.ts test/ai-theme-apply.test.ts && npm test && npx tsc --noEmit`
Expected: 3 new tests pass; existing AI tests pass; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/services/ai-generator.ts apps/worker/src/routes/ai.ts apps/worker/test/audit-ai-routes.test.ts
aramid check --staged
git commit -m "feat(audit): record AI calls with model, route, tokens and cost; flag fallback themes"
```

---

### Task 8: Sealer and archive (per-minute cron)

**Files:**
- Create: `apps/worker/src/audit/sealer.ts`
- Modify: `apps/worker/src/bindings.ts` (add `AUDIT_ARCHIVE: R2Bucket`)
- Modify: `apps/worker/wrangler.toml` (R2 binding + minute cron, production and staging)
- Modify: `apps/worker/vitest.config.ts` (`r2Buckets: ["ASSETS", "AUDIT_ARCHIVE"]`)
- Modify: `apps/worker/src/index.ts` (`scheduled`: minute branch)
- Test: `apps/worker/test/audit-sealer.test.ts`

**Interfaces:**
- Consumes: `entryHash`, `chainHash`, `GENESIS`, `archiveLine`, `AuditRow` (Task 3); `systemAudit` (Task 4).
- Produces: `runSealer(env: { DB; AUDIT_ARCHIVE }, now?: Date): Promise<SealResult>`, `SEAL_BATCH`, `LEASE_MS`, `STALE_STARTED_MS`, `archiveKey(firstSeq, lastSeq, sealedAt)`.

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/audit-sealer.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chainHash, GENESIS, type AuditRow } from "@repo/audit";
import { runSealer } from "../src/audit/sealer";
import { systemAudit } from "../src/audit/context";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };
const rows = () => E.DB.prepare("SELECT * FROM audit_log WHERE seq IS NOT NULL ORDER BY seq").all<AuditRow>().then((r) => r.results ?? []);

describe("sealer", () => {
  it("seals in order, chains from GENESIS and archives", async () => {
    for (let i = 0; i < 3; i++) await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { i } });
    const res = await runSealer(E);
    expect(res).toMatchObject({ skipped: false, sealed: 3, archived: 3, tampered: [] });
    const sealed = await rows();
    expect(sealed.map((r) => r.seq)).toEqual([1, 2, 3]);
    let prev = GENESIS;
    for (const r of sealed) {
      prev = await chainHash(prev, r.entry_hash);
      expect(r.chain_hash).toBe(prev);
      expect(r.archived_at).not.toBeNull();
    }
    const obj = await E.AUDIT_ARCHIVE.get(sealed[0]!.archive_key!);
    expect((await obj!.text()).trim().split("\n")).toHaveLength(3);
  });

  it("skips while another run holds the lease", async () => {
    await E.DB.prepare("UPDATE audit_seal_state SET holder = 'other', lease_until = ? WHERE id = 1")
      .bind(new Date(Date.now() + 60_000).toISOString()).run();
    try {
      expect(await runSealer(E)).toMatchObject({ skipped: true });
    } finally {
      await E.DB.prepare("UPDATE audit_seal_state SET holder = NULL, lease_until = NULL WHERE id = 1").run();
    }
  });

  it("leaves rows unarchived when the put fails, and re-archives them next run", async () => {
    await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded" });
    const failing = { head: async () => null, get: async () => null, put: async () => { throw new Error("r2 down"); } } as unknown as R2Bucket;
    const first = await runSealer({ DB: E.DB, AUDIT_ARCHIVE: failing });
    expect(first.archiveError).toMatch(/r2 down/);
    const pending = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NOT NULL AND archived_at IS NULL").first<{ n: number }>();
    expect(pending!.n).toBeGreaterThan(0);
    const second = await runSealer(E);
    expect(second.archived).toBe(pending!.n);
  });

  it("marks a started entry with no outcome after 15 minutes as unknown", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const startedId = await systemAudit(E.DB, "queue").write({ action: "ai.call", phase: "started", occurredAt: old });
    await runSealer(E);
    const child = await E.DB.prepare("SELECT outcome, phase FROM audit_log WHERE parent_id = ?").bind(startedId).first();
    expect(child).toEqual({ outcome: "unknown", phase: "outcome" });
  });
});
```

A fifth test (an upload that landed while the `archived_at` update was lost) calls `archivePending` directly; it is added in Step 3 once that function exists.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker && npx vitest run test/audit-sealer.test.ts`
Expected: FAIL, cannot resolve `../src/audit/sealer`.

- [ ] **Step 3: Write the sealer**

`apps/worker/src/audit/sealer.ts`:

```ts
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { archiveLine, chainHash, entryHash, GENESIS, type AuditRow } from "@repo/audit";
import { systemAudit } from "./context.js";

export const SEAL_BATCH = 500;
export const ARCHIVE_BATCH = 500;
export const LEASE_MS = 50_000;
export const STALE_STARTED_MS = 15 * 60_000;

export interface SealResult {
  skipped: boolean;
  sealed: number;
  archived: number;
  unknownMarked: number;
  tampered: string[];
  archiveError?: string;
}

type SealEnv = { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

const pad = (n: number) => String(n).padStart(12, "0");

export function archiveKey(firstSeq: number, lastSeq: number, sealedAt: string): string {
  return `${sealedAt.slice(0, 10).replace(/-/g, "/")}/${pad(firstSeq)}-${pad(lastSeq)}.jsonl`;
}

export async function runSealer(env: SealEnv, now = new Date()): Promise<SealResult> {
  const holder = crypto.randomUUID();
  const nowIso = now.toISOString();
  const lease = await env.DB.prepare(
    "UPDATE audit_seal_state SET holder = ?, lease_until = ? WHERE id = 1 AND (lease_until IS NULL OR lease_until < ?)"
  )
    .bind(holder, new Date(now.getTime() + LEASE_MS).toISOString(), nowIso)
    .run();
  if ((lease.meta?.changes ?? 0) === 0) {
    return { skipped: true, sealed: 0, archived: 0, unknownMarked: 0, tampered: [] };
  }
  try {
    const unknownMarked = await markUnknownOutcomes(env.DB, now);
    const { sealed, tampered } = await sealBatch(env.DB, nowIso);
    let archived = 0;
    let archiveError: string | undefined;
    try {
      archived = await archivePending(env.DB, env.AUDIT_ARCHIVE, nowIso);
    } catch (err) {
      archiveError = err instanceof Error ? err.message : String(err);
      console.error("[audit] archive failed; will retry next run:", archiveError);
    }
    if (tampered.length) console.error("[audit] entry_hash mismatch on unsealed rows:", tampered.join(","));
    return { skipped: false, sealed, archived, unknownMarked, tampered, ...(archiveError ? { archiveError } : {}) };
  } finally {
    await env.DB.prepare("UPDATE audit_seal_state SET holder = NULL, lease_until = NULL WHERE id = 1 AND holder = ?")
      .bind(holder)
      .run();
  }
}

async function markUnknownOutcomes(db: D1Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_STARTED_MS).toISOString();
  const stale = await db
    .prepare(
      `SELECT * FROM audit_log s WHERE s.phase = 'started' AND s.occurred_at < ?
       AND NOT EXISTS (SELECT 1 FROM audit_log o WHERE o.parent_id = s.id) LIMIT 100`
    )
    .bind(cutoff)
    .all<AuditRow>();
  const rec = systemAudit(db, "cron");
  for (const s of stale.results ?? []) {
    await rec.write({
      action: s.action as never,
      phase: "outcome",
      outcome: "unknown",
      reason: "no outcome recorded within 15 minutes",
      shopId: s.shop_id,
      entityType: s.entity_type,
      entityId: s.entity_id,
      parentId: s.id,
    });
  }
  return stale.results?.length ?? 0;
}

async function sealBatch(db: D1Database, nowIso: string): Promise<{ sealed: number; tampered: string[] }> {
  const last = await db
    .prepare("SELECT seq, chain_hash FROM audit_log WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1")
    .first<{ seq: number; chain_hash: string }>();
  const state = await db.prepare("SELECT expired_through_seq, expired_chain_hash FROM audit_seal_state WHERE id = 1")
    .first<{ expired_through_seq: number; expired_chain_hash: string | null }>();
  let seq = last?.seq ?? state?.expired_through_seq ?? 0;
  let prev = last?.chain_hash ?? state?.expired_chain_hash ?? GENESIS;
  const rows = await db
    .prepare("SELECT * FROM audit_log WHERE sealed_at IS NULL ORDER BY occurred_at, id LIMIT ?")
    .bind(SEAL_BATCH)
    .all<AuditRow>();
  const stmts = [];
  const tampered: string[] = [];
  for (const row of rows.results ?? []) {
    if ((await entryHash(row)) !== row.entry_hash) {
      tampered.push(row.id);
      continue;
    }
    seq += 1;
    prev = await chainHash(prev, row.entry_hash);
    stmts.push(
      db.prepare("UPDATE audit_log SET seq = ?, sealed_at = ?, chain_hash = ? WHERE id = ? AND sealed_at IS NULL")
        .bind(seq, nowIso, prev, row.id)
    );
  }
  if (stmts.length) await db.batch(stmts);
  return { sealed: stmts.length, tampered };
}

export async function archivePending(db: D1Database, bucket: R2Bucket, nowIso: string): Promise<number> {
  const res = await db
    .prepare("SELECT * FROM audit_log WHERE sealed_at IS NOT NULL AND archived_at IS NULL ORDER BY seq LIMIT ?")
    .bind(ARCHIVE_BATCH)
    .all<AuditRow>();
  const rows = res.results ?? [];
  if (!rows.length) return 0;
  const first = rows[0]!.seq!;
  const last = rows[rows.length - 1]!.seq!;
  const key = archiveKey(first, last, rows[0]!.sealed_at!);
  const body = rows.map(archiveLine).join("\n") + "\n";
  if (await bucket.head(key)) {
    // Locked buckets refuse overwrites: accept an identical earlier upload.
    const existing = await bucket.get(key);
    if ((await existing?.text()) !== body) throw new Error(`archive conflict at ${key}`);
  } else {
    await bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });
  }
  await db
    .prepare("UPDATE audit_log SET archived_at = ?, archive_key = ? WHERE seq BETWEEN ? AND ? AND archived_at IS NULL")
    .bind(nowIso, key, first, last)
    .run();
  return rows.length;
}
```

Add the fifth sealer test (append inside the `describe`):

```ts
  it("archivePending accepts an identical pre-existing object", async () => {
    const { archivePending, archiveKey } = await import("../src/audit/sealer");
    await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded" });
    await runSealer({ DB: E.DB, AUDIT_ARCHIVE: { head: async () => null, get: async () => null, put: async () => { throw new Error("down"); } } as unknown as R2Bucket });
    const pending = (await E.DB.prepare("SELECT * FROM audit_log WHERE sealed_at IS NOT NULL AND archived_at IS NULL ORDER BY seq").all<AuditRow>()).results!;
    const { archiveLine } = await import("@repo/audit");
    const body = pending.map(archiveLine).join("\n") + "\n";
    const key = archiveKey(pending[0]!.seq!, pending[pending.length - 1]!.seq!, pending[0]!.sealed_at!);
    await E.AUDIT_ARCHIVE.put(key, body);
    expect(await archivePending(E.DB, E.AUDIT_ARCHIVE, new Date().toISOString())).toBe(pending.length);
  });
```

- [ ] **Step 4: Wire configuration**

`apps/worker/src/bindings.ts`, add after `ASSETS: R2Bucket;`:

```ts
  /** Append-only audit archive (retention-locked bucket, spec 5.2). */
  AUDIT_ARCHIVE: R2Bucket;
```

`apps/worker/vitest.config.ts`: `r2Buckets: ["ASSETS", "AUDIT_ARCHIVE"],`

`apps/worker/wrangler.toml`: after the production `[[r2_buckets]]` block add

```toml
# Audit archive (retention-locked; create + lock BEFORE deploying, see docs/runbooks/audit-trail-rollout.md)
[[r2_buckets]]
binding = "AUDIT_ARCHIVE"
bucket_name = "pivot-parlor-audit"
```

after the staging `[[env.staging.r2_buckets]]` block add

```toml
[[env.staging.r2_buckets]]
binding = "AUDIT_ARCHIVE"
bucket_name = "pivot-parlor-audit-staging"
```

and change both cron lists (production `[triggers]` and `[env.staging.triggers]`) to:

```toml
crons = ["* * * * *", "0 3 * * *", "0 8 * * *", "0 20 * * *"]
```

Add a comment line above the production list: `# * * * * * — audit sealer (seal new entries into the chain + archive)`.

`apps/worker/src/index.ts`, import `import { runSealer } from "./audit/sealer.js";` and add as the FIRST branch of `scheduled`:

```ts
    // Every minute — audit sealer (spec 5.1). Quiet unless something is wrong.
    if (cron === "* * * * *") {
      const r = await runSealer(env);
      if (r.tampered.length || r.archiveError) console.error("[Cron audit-seal]", JSON.stringify(r));
      return;
    }
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/worker && npx vitest run test/audit-sealer.test.ts test/audit-coverage.test.ts && npm test && npx tsc --noEmit`
Expected: 5 sealer tests pass; coverage test sees the new minute cron; full suite and tsc pass.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/audit/sealer.ts apps/worker/src/bindings.ts apps/worker/wrangler.toml apps/worker/vitest.config.ts apps/worker/src/index.ts apps/worker/test/audit-sealer.test.ts
aramid check --staged
git commit -m "feat(audit): per-minute sealer - hash chain, lease, unknown outcomes, R2 archive"
```

---

### Task 9: Verifier, nightly check, daily anchor and alert emails

**Files:**
- Create: `apps/worker/src/audit/verify.ts`, `apps/worker/src/audit/nightly.ts`
- Modify: `apps/worker/src/services/email.ts` (add `sendAuditEmail`)
- Modify: `apps/worker/src/index.ts` (03:00 branch runs the nightly after the retention sweep)
- Test: `apps/worker/test/audit-verify.test.ts`

**Interfaces:**
- Consumes: `runSealer`, `archiveKey` (Task 8); `entryHash`, `chainHash`, `archiveLine`, `GENESIS` (Task 3).
- Produces: `verifyRange(db, bucket, fromSeq, toSeq): Promise<VerifyResult>`; `runAuditNightly(env, now?, send?)`; `sendAuditEmail(apiKey, to, subject, lines: string[])`.

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/audit-verify.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chainHash, entryHash, type AuditRow } from "@repo/audit";
import { systemAudit } from "../src/audit/context";
import { runSealer } from "../src/audit/sealer";
import { verifyRange } from "../src/audit/verify";
import { runAuditNightly } from "../src/audit/nightly";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket; RESEND_API_KEY?: string };

async function sealedTrail(n: number) {
  for (let i = 0; i < n; i++) await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { i } });
  await runSealer(E);
  const max = await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>();
  return max!.m;
}

async function dropTriggers() {
  await E.DB.prepare("DROP TRIGGER IF EXISTS audit_log_seal_only").run();
}

describe("verifyRange", () => {
  it("passes on an untouched trail", async () => {
    const max = await sealedTrail(4);
    expect(await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1, max)).toMatchObject({ ok: true, checked: max });
  });

  it("catches a naive edit at the edited seq", async () => {
    const max = await sealedTrail(3);
    await dropTriggers(); // an attacker with database access
    await E.DB.prepare("UPDATE audit_log SET reason = 'forged' WHERE seq = 2").run();
    const r = await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1, max);
    expect(r).toMatchObject({ ok: false, firstBadSeq: 2 });
    expect(r.problem).toMatch(/entry_hash/);
  });

  it("catches an edit that recomputes every later hash, via the archive", async () => {
    const max = await sealedTrail(3);
    await dropTriggers();
    const rows = (await E.DB.prepare("SELECT * FROM audit_log WHERE seq IS NOT NULL ORDER BY seq").all<AuditRow>()).results!;
    let prev = rows[0]!.seq === 1 ? "GENESIS" : rows[0]!.chain_hash!;
    for (const r of rows) {
      const forged = r.seq === 2 ? { ...r, reason: "forged" } : r;
      const eh = await entryHash(forged);
      prev = await chainHash(prev, eh);
      await E.DB.prepare("UPDATE audit_log SET reason = ?, entry_hash = ?, chain_hash = ? WHERE id = ?")
        .bind(forged.reason, eh, prev, r.id).run();
    }
    const res = await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1, max);
    expect(res.ok).toBe(false);
    expect(res.problem).toMatch(/archive/);
  });
});

describe("runAuditNightly", () => {
  it("records an audit.verify entry and emails the anchor", async () => {
    await E.DB.prepare("INSERT OR IGNORE INTO platform_users (id, name, email, password_hash, role) VALUES ('dev-n', 'Dev', 'dev@test.local', 'x', 'developer')").run();
    await sealedTrail(2);
    const sent: { subject: string; lines: string[] }[] = [];
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    await runAuditNightly({ ...E, RESEND_API_KEY: "re_test" }, tomorrow, async (_k, _to, subject, lines) => { sent.push({ subject, lines }); });
    const entry = await E.DB.prepare("SELECT outcome, details_json FROM audit_log WHERE action = 'audit.verify' AND via = 'cron' AND details_json LIKE '%checked%' ORDER BY occurred_at DESC LIMIT 1").first<{ outcome: string; details_json: string }>();
    expect(entry!.outcome).toBe("succeeded");
    expect(sent.some((m) => /anchor/i.test(m.subject))).toBe(true);
    const anchorKey = `anchors/${new Date().toISOString().slice(0, 10)}.json`;
    expect(await E.AUDIT_ARCHIVE.head(anchorKey)).not.toBeNull();
  });
});
```

Each test file gets its own database, but the three `verifyRange` tests share one file; each builds on the previous rows. The second and third drop the trigger; run the naive-edit test before the recompute test (Vitest runs them in order) and keep `sealedTrail` appending fresh rows each time.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker && npx vitest run test/audit-verify.test.ts`
Expected: FAIL, cannot resolve `../src/audit/verify`.

- [ ] **Step 3: Write the verifier**

`apps/worker/src/audit/verify.ts`:

```ts
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { archiveLine, chainHash, entryHash, GENESIS, type AuditRow } from "@repo/audit";

export interface VerifyResult {
  ok: boolean;
  fromSeq: number;
  toSeq: number;
  checked: number;
  firstBadSeq: number | null;
  problem: string | null;
}

const PAGE = 500;

export async function verifyRange(db: D1Database, bucket: R2Bucket, fromSeq: number, toSeq: number): Promise<VerifyResult> {
  const fail = (checked: number, seq: number, problem: string): VerifyResult =>
    ({ ok: false, fromSeq, toSeq, checked, firstBadSeq: seq, problem });

  let prev: string;
  if (fromSeq <= 1) {
    prev = GENESIS;
  } else {
    const before = await db.prepare("SELECT chain_hash FROM audit_log WHERE seq = ?").bind(fromSeq - 1).first<{ chain_hash: string }>();
    const state = await db.prepare("SELECT expired_through_seq, expired_chain_hash FROM audit_seal_state WHERE id = 1")
      .first<{ expired_through_seq: number; expired_chain_hash: string | null }>();
    const p = before?.chain_hash ?? (state?.expired_through_seq === fromSeq - 1 ? state.expired_chain_hash : null);
    if (!p) return fail(0, fromSeq - 1, `no chain value before seq ${fromSeq}`);
    prev = p;
  }

  const archives = new Map<string, Map<string, string>>();
  async function archived(key: string): Promise<Map<string, string>> {
    let m = archives.get(key);
    if (m) return m;
    m = new Map();
    const obj = await bucket.get(key);
    const text = obj ? await obj.text() : "";
    for (const line of text.split("\n")) {
      if (!line) continue;
      const id = (JSON.parse(line) as { id: string }).id;
      m.set(id, line);
    }
    archives.set(key, m);
    return m;
  }

  let expected = fromSeq;
  let checked = 0;
  while (expected <= toSeq) {
    const page = await db
      .prepare("SELECT * FROM audit_log WHERE seq >= ? AND seq <= ? ORDER BY seq LIMIT ?")
      .bind(expected, toSeq, PAGE)
      .all<AuditRow>();
    const rows = page.results ?? [];
    if (!rows.length) return fail(checked, expected, `missing seq ${expected}`);
    for (const row of rows) {
      if (row.seq !== expected) return fail(checked, expected, `missing seq ${expected}`);
      if ((await entryHash(row)) !== row.entry_hash) return fail(checked, expected, "entry_hash does not match the entry");
      prev = await chainHash(prev, row.entry_hash);
      if (prev !== row.chain_hash) return fail(checked, expected, "chain_hash breaks the chain");
      if (row.archive_key) {
        const copy = (await archived(row.archive_key)).get(row.id);
        if (copy === undefined) return fail(checked, expected, `entry missing from archive ${row.archive_key}`);
        if (copy !== archiveLine(row)) return fail(checked, expected, `entry differs from archive ${row.archive_key}`);
      }
      checked++;
      expected++;
    }
  }
  return { ok: true, fromSeq, toSeq, checked, firstBadSeq: null, problem: null };
}
```

- [ ] **Step 4: Add the email helper**

In `apps/worker/src/services/email.ts`, after `sendEodAlert`:

```ts
// ─── Audit trail alerts and daily anchor (spec 5.3, 5.4) ─────────────────────

export async function sendAuditEmail(apiKey: string, to: string, subject: string, lines: string[]): Promise<void> {
  const body = lines.map((l) => `<p style="margin:0 0 8px;font-family:monospace;font-size:13px">${escapeHtml(l)}</p>`).join("");
  await sendEmail(apiKey, to, subject, emailBaseLayout(emailHeader(subject, "Pivot Parlor audit trail") + emailBodySection(body), "Pivot Parlor"));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
```

(If `email.ts` already has an HTML escape helper, use it instead of adding `escapeHtml`.)

- [ ] **Step 5: Write the nightly job**

`apps/worker/src/audit/nightly.ts`:

```ts
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { sendAuditEmail } from "../services/email.js";
import { systemAudit } from "./context.js";
import { verifyRange, type VerifyResult } from "./verify.js";

export const WALK_ROWS_PER_NIGHT = 20_000;

type NightlyEnv = { DB: D1Database; AUDIT_ARCHIVE: R2Bucket; RESEND_API_KEY?: string };
type Send = typeof sendAuditEmail;

export async function runAuditNightly(env: NightlyEnv, now = new Date(), send: Send = sendAuditEmail): Promise<void> {
  const db = env.DB;
  const state = await db.prepare("SELECT last_verified_seq, walk_cursor_seq, expired_through_seq FROM audit_seal_state WHERE id = 1")
    .first<{ last_verified_seq: number; walk_cursor_seq: number; expired_through_seq: number }>();
  const maxRow = await db.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number | null }>();
  const maxSeq = maxRow?.m ?? 0;
  const floor = (state?.expired_through_seq ?? 0) + 1;

  // 1. New entries since the last successful check.
  const incFrom = Math.max(floor, (state?.last_verified_seq ?? 0) + 1);
  const incTo = Math.min(maxSeq, incFrom + WALK_ROWS_PER_NIGHT - 1);
  const incremental: VerifyResult | null = incTo >= incFrom ? await verifyRange(db, env.AUDIT_ARCHIVE, incFrom, incTo) : null;
  if (incremental?.ok) {
    await db.prepare("UPDATE audit_seal_state SET last_verified_seq = ? WHERE id = 1").bind(incTo).run();
  }

  // 2. Rotating re-walk of older history (Plan 1 decision 9).
  let walkFrom = Math.max(floor, (state?.walk_cursor_seq ?? 0) + 1);
  if (walkFrom > maxSeq) walkFrom = floor;
  const walkTo = Math.min(maxSeq, walkFrom + WALK_ROWS_PER_NIGHT - 1);
  const walk: VerifyResult | null = walkTo >= walkFrom ? await verifyRange(db, env.AUDIT_ARCHIVE, walkFrom, walkTo) : null;
  if (walk) await db.prepare("UPDATE audit_seal_state SET walk_cursor_seq = ? WHERE id = 1").bind(walk.ok ? walkTo : 0).run();

  // 3. Health counts.
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const count = async (sql: string, ...binds: unknown[]) =>
    (await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const unsealed = await count("SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NULL AND occurred_at < ?", iso(10 * 60_000));
  const unarchived = await count("SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NOT NULL AND archived_at IS NULL AND sealed_at < ?", iso(3600_000));
  const unknown = await count("SELECT COUNT(*) AS n FROM audit_log WHERE outcome = 'unknown' AND occurred_at >= ?", iso(24 * 3600_000));

  // 4. Daily anchor for the previous UTC day.
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00.000Z`) - 24 * 3600_000).toISOString().slice(0, 10);
  const anchorRow = await db.prepare("SELECT seq, chain_hash FROM audit_log WHERE seq IS NOT NULL AND sealed_at < ? ORDER BY seq DESC LIMIT 1")
    .bind(`${today}T00:00:00.000Z`)
    .first<{ seq: number; chain_hash: string }>();
  const anchorKey = `anchors/${yesterday}.json`;
  if (anchorRow && !(await env.AUDIT_ARCHIVE.head(anchorKey))) {
    await env.AUDIT_ARCHIVE.put(anchorKey, JSON.stringify({ date: yesterday, seq: anchorRow.seq, chain_hash: anchorRow.chain_hash }));
  }

  const problems = [
    incremental && !incremental.ok ? `Check failed at seq ${incremental.firstBadSeq}: ${incremental.problem}` : null,
    walk && !walk.ok ? `History re-walk failed at seq ${walk.firstBadSeq}: ${walk.problem}` : null,
    unsealed ? `${unsealed} entries unsealed for more than 10 minutes` : null,
    unarchived ? `${unarchived} sealed entries unarchived for more than 1 hour` : null,
    unknown ? `${unknown} actions in the last 24 hours have no recorded outcome` : null,
  ].filter((x): x is string => x !== null);

  await systemAudit(db, "cron").write({
    action: "audit.verify",
    outcome: problems.length ? "failed" : "succeeded",
    reason: problems.length ? problems.join("; ").slice(0, 500) : null,
    details: {
      checked: (incremental?.checked ?? 0) + (walk?.checked ?? 0),
      incremental: incremental && { from: incremental.fromSeq, to: incremental.toSeq, ok: incremental.ok },
      walk: walk && { from: walk.fromSeq, to: walk.toSeq, ok: walk.ok },
      unsealed, unarchived, unknown,
      anchor: anchorRow ? { date: yesterday, seq: anchorRow.seq } : null,
    },
  });

  const dev = await db.prepare("SELECT email FROM platform_users WHERE role = 'developer' LIMIT 1").first<{ email: string }>();
  if (!dev?.email || !env.RESEND_API_KEY) return;
  if (anchorRow) {
    await send(env.RESEND_API_KEY, dev.email, `Audit anchor ${yesterday}`, [
      `Date: ${yesterday}`,
      `Last sealed entry: ${anchorRow.seq}`,
      `Chain fingerprint: ${anchorRow.chain_hash}`,
      "Keep this email. It proves what the audit trail said on this date.",
    ]);
  }
  if (problems.length) {
    await send(env.RESEND_API_KEY, dev.email, "Audit trail needs attention", problems);
  }
}
```

In `apps/worker/src/index.ts`, import `import { runAuditNightly } from "./audit/nightly.js";` and in the `0 3 * * *` branch, before its `return;`, add:

```ts
      try {
        await runAuditNightly(env);
      } catch (err) {
        console.error("[Cron 03:00] Audit nightly check failed:", err);
      }
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/worker && npx vitest run test/audit-verify.test.ts && npm test && npx tsc --noEmit`
Expected: 4 passed; full suite and tsc pass.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/audit/verify.ts apps/worker/src/audit/nightly.ts apps/worker/src/services/email.ts apps/worker/src/index.ts apps/worker/test/audit-verify.test.ts
aramid check --staged
git commit -m "feat(audit): chain+archive verifier, nightly check, daily anchor and alert emails"
```

---

### Task 10: Retention: blanking and 6-year expiry

**Files:**
- Create: `apps/worker/src/audit/retention.ts`
- Modify: `apps/worker/src/services/retention.ts` (add the two sweeps to `runRetentionSweep`)
- Test: `apps/worker/test/audit-retention.test.ts`

**Interfaces:**
- Consumes: `systemAudit` (Task 4), `verifyRange` (Task 9), `runSealer` (Task 8).
- Produces: `redactDueSubjects(db, now, max): Promise<number>`, `expireOldEntries(db, now, max): Promise<number>`, `AUDIT_RETENTION_DAYS = 2192`.

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/audit-retention.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuditRecorder } from "@repo/audit";
import { runSealer } from "../src/audit/sealer";
import { verifyRange } from "../src/audit/verify";
import { expireOldEntries, redactDueSubjects } from "../src/audit/retention";
import { seedUser } from "./helpers";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

describe("audit retention", () => {
  it("blanks due personal details and the chain still verifies", async () => {
    const userId = await seedUser("admin", null);
    await createAuditRecorder({ db: E.DB, worker: "t", via: "api", actor: { type: "admin", userId, role: "admin", ip: "192.0.2.44" }, requestId: null })
      .write({ action: "site.pause", outcome: "succeeded" });
    await runSealer(E);
    await E.DB.prepare("UPDATE audit_subjects SET redact_after = ? WHERE user_id = ?").bind(new Date(Date.now() - 1000).toISOString(), userId).run();
    expect(await redactDueSubjects(E.DB, new Date(), 500)).toBeGreaterThan(0);
    const s = await E.DB.prepare("SELECT display_name, email, ip, redacted_at FROM audit_subjects WHERE user_id = ?").bind(userId).first();
    expect(s).toMatchObject({ display_name: null, email: null, ip: null });
    const max = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;
    await runSealer(E);
    const max2 = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;
    expect((await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1, max2)).ok).toBe(true);
    expect(max2).toBeGreaterThan(max); // the subject.redact entry itself was sealed
  });
});
```

`apps/worker/test/audit-retention-expiry.test.ts` (its own file, so the old entry is the very first one in the chain and therefore an expirable prefix):

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuditRecorder } from "@repo/audit";
import { runSealer } from "../src/audit/sealer";
import { verifyRange } from "../src/audit/verify";
import { expireOldEntries } from "../src/audit/retention";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

describe("audit expiry", () => {
  it("expires archived entries older than 6 years and the rest still verifies", async () => {
    const old = new Date(Date.now() - 2200 * 24 * 3600 * 1000).toISOString();
    const rec = createAuditRecorder({ db: E.DB, worker: "t", via: "cron", actor: { type: "system" }, requestId: null });
    await rec.write({ action: "audit.verify", outcome: "succeeded", occurredAt: old });
    await rec.write({ action: "audit.verify", outcome: "succeeded" });
    await runSealer(E);
    const deleted = await expireOldEntries(E.DB, new Date(), 500);
    expect(deleted).toBe(1);
    await runSealer(E);
    const st = await E.DB.prepare("SELECT expired_through_seq FROM audit_seal_state WHERE id = 1").first<{ expired_through_seq: number }>();
    const max = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;
    expect((await verifyRange(E.DB, E.AUDIT_ARCHIVE, st!.expired_through_seq + 1, max)).ok).toBe(true);
  });
});
```

`expireOldEntries` only deletes a contiguous prefix of the chain: an old row that was sealed after younger ones (sealing order, not occurrence order) waits until everything before it has expired. The expiry test therefore lives in its own file, where the old row is the first entry ever sealed.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker && npx vitest run test/audit-retention.test.ts test/audit-retention-expiry.test.ts`
Expected: FAIL, cannot resolve `../src/audit/retention`.

- [ ] **Step 3: Write the retention module**

`apps/worker/src/audit/retention.ts`:

```ts
import type { D1Database } from "@cloudflare/workers-types";
import { systemAudit } from "./context.js";

export const AUDIT_RETENTION_DAYS = 2192;

/** Blank name/email/IP for subjects whose redact_after has passed (spec 6.2). */
export async function redactDueSubjects(db: D1Database, now: Date, max: number): Promise<number> {
  const nowIso = now.toISOString();
  const due = await db
    .prepare("SELECT id FROM audit_subjects WHERE redact_after <= ? AND redacted_at IS NULL LIMIT ?")
    .bind(nowIso, max)
    .all<{ id: string }>();
  const ids = (due.results ?? []).map((r) => r.id);
  if (!ids.length) return 0;
  const blank = ids.map((id) =>
    db.prepare("UPDATE audit_subjects SET display_name = NULL, email = NULL, ip = NULL, redacted_at = ? WHERE id = ? AND redacted_at IS NULL")
      .bind(nowIso, id)
  );
  const audit = await systemAudit(db, "cron").statements({
    action: "subject.redact",
    outcome: "succeeded",
    details: { count: ids.length, subject_ids: ids },
  });
  await db.batch([...blank, ...audit]);
  return ids.length;
}

/** Delete archived entries older than 6 years, only as a contiguous prefix of the chain. */
export async function expireOldEntries(db: D1Database, now: Date, max: number): Promise<number> {
  const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  const firstKeep = await db
    .prepare("SELECT MIN(seq) AS s FROM audit_log WHERE seq IS NOT NULL AND (occurred_at >= ? OR archived_at IS NULL)")
    .bind(cutoff)
    .first<{ s: number | null }>();
  const rows = await db
    .prepare(
      `SELECT id, seq, chain_hash FROM audit_log WHERE seq IS NOT NULL AND occurred_at < ? AND archived_at IS NOT NULL
       AND (? IS NULL OR seq < ?) ORDER BY seq LIMIT ?`
    )
    .bind(cutoff, firstKeep?.s ?? null, firstKeep?.s ?? null, max)
    .all<{ id: string; seq: number; chain_hash: string }>();
  const list = rows.results ?? [];
  if (!list.length) return 0;
  const last = list[list.length - 1]!;
  const del = list.map((r) => db.prepare("DELETE FROM audit_log WHERE id = ?").bind(r.id));
  const state = db
    .prepare("UPDATE audit_seal_state SET expired_through_seq = ?, expired_chain_hash = ? WHERE id = 1")
    .bind(last.seq, last.chain_hash);
  const audit = await systemAudit(db, "cron").statements({
    action: "audit.expire",
    outcome: "succeeded",
    details: { from_seq: list[0]!.seq, to_seq: last.seq, count: list.length },
  });
  await db.batch([...del, state, ...audit]);
  return list.length;
}
```

In `apps/worker/src/services/retention.ts`, import both functions and append to the `sweeps` array:

```ts
    ["audit_subjects_redacted", () => redactDueSubjects(db, new Date(), maxPerTable)],
    ["audit_log_expired", () => expireOldEntries(db, new Date(), maxPerTable)],
```

Also add to the file's header comment under "What is deliberately KEPT": `- audit_log: 6 years (spec 2026-09-26); personal details live in audit_subjects and are blanked 30 days after a shop leaves or an erasure request.`

- [ ] **Step 4: Run the tests**

Run: `cd apps/worker && npx vitest run test/audit-retention.test.ts test/audit-retention-expiry.test.ts test/retention.test.ts && npm test && npx tsc --noEmit`
Expected: all pass. If `retention.test.ts` asserts the exact key set of `counts`, add the two new keys to its expectation.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/audit/retention.ts apps/worker/src/services/retention.ts apps/worker/test/audit-retention*.test.ts apps/worker/test/retention.test.ts
aramid check --staged
git commit -m "feat(audit): blank personal details after 30 days and expire entries after 6 years"
```

---

### Task 11: Audit API: list, verify, exports, erasure request, historical import

**Files:**
- Create: `apps/worker/src/routes/audit.ts`
- Modify: `apps/worker/src/index.ts` (mount `/api/audit`)
- Modify: `apps/worker/src/audit/registry.ts` (declare the three new POST routes)
- Test: `apps/worker/test/audit-api.test.ts`

**Interfaces:**
- Consumes: `auditFor`, `auditRefused` (Task 4); `verifyRange` (Task 9); `userSubjectId`, `AuditWriteError` (Task 3).
- Produces (developer-only, JSON envelope unless noted):
  - `GET /api/audit?shop_id&actor&action&outcome&from&to&cursor` → `{ entries: AuditListEntry[], next_cursor: string | null }`
  - `POST /api/audit/verify` body `{ from_seq?, to_seq? }` → `VerifyResult`
  - `GET /api/audit/export?<same filters>&part=csv|proof` → `text/csv` or proof JSON
  - `GET /api/audit/subjects/:subjectId/export` → `{ subject, entries }`
  - `POST /api/audit/subjects/:userId/erase` → `{ redact_after }`
  - `POST /api/audit/import-historical` → `{ imported }`
  - `AuditListEntry` = audit_log row + `actor_name`, `actor_email`, `ip`, `redacted` (boolean).

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/audit-api.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedShop, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";
import { runSealer } from "../src/audit/sealer";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

async function dev() {
  const id = await seedUser("developer", null);
  return { id, token: await tokenFor(id, "developer", null) };
}

describe("/api/audit", () => {
  it("lists entries with actor details and logs the view", async () => {
    const { id, token } = await dev();
    const shopId = await seedShop("Api Shop");
    await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
    const res = await dispatch("GET", `/api/audit?shop_id=${shopId}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entries: { action: string; actor_email: string }[] } };
    expect(body.data.entries[0]).toMatchObject({ action: "site.pause", actor_email: `${id}@test.local` });
    const view = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.view'").first<{ n: number }>();
    expect(view!.n).toBeGreaterThan(0);
  });

  it("is developer-only", async () => {
    const shopId = await seedShop("Admin Shop");
    const adminId = await seedUser("admin", shopId);
    const res = await dispatch("GET", "/api/audit", { headers: authHeaders(await tokenFor(adminId, "admin", shopId)) });
    expect(res.status).toBe(403);
  });

  it("verifies a range", async () => {
    const { token } = await dev();
    await runSealer(E);
    const res = await dispatch("POST", "/api/audit/verify", { headers: authHeaders(token), body: {} });
    expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(true);
  });

  it("exports CSV with a header row and a proof file", async () => {
    const { token } = await dev();
    const csv = await dispatch("GET", "/api/audit/export?part=csv", { headers: authHeaders(token) });
    expect(csv.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect((await csv.text()).split("\n")[0]).toBe("occurred_at,seq,action,outcome,actor,actor_email,shop_id,entity_type,entity_id,changes,details,request_id,sealed,archived");
    const proof = await dispatch("GET", "/api/audit/export?part=proof", { headers: authHeaders(token) });
    expect(await proof.json()).toHaveProperty("data.first");
  });

  it("records an erasure request 30 days out", async () => {
    const { token } = await dev();
    const target = await seedUser("customer", null);
    await E.DB.prepare("INSERT INTO audit_subjects (id, kind, user_id, created_at) VALUES (?, 'user', ?, ?)").bind(`subj_user_${target}`, target, new Date().toISOString()).run();
    const res = await dispatch("POST", `/api/audit/subjects/${target}/erase`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const s = await E.DB.prepare("SELECT redact_after FROM audit_subjects WHERE id = ?").bind(`subj_user_${target}`).first<{ redact_after: string }>();
    expect(Date.parse(s!.redact_after)).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
  });

  it("imports ai_usage_log once, as historical ai.call entries", async () => {
    const { token } = await dev();
    const shopId = await seedShop("Hist Shop");
    await E.DB.prepare(
      "INSERT INTO ai_usage_log (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, created_at) VALUES ('u-1', ?, 'pivot-parlor-chatbot', 'm', 'chatbot', 10, 5, 15, 0.001, '2026-03-24 21:40:44')"
    ).bind(shopId).run();
    await dispatch("POST", "/api/audit/import-historical", { headers: authHeaders(token) });
    await dispatch("POST", "/api/audit/import-historical", { headers: authHeaders(token) });
    const rows = await E.DB.prepare("SELECT historical, occurred_at FROM audit_log WHERE id = 'hist_u-1'").all();
    expect(rows.results).toEqual([{ historical: 1, occurred_at: "2026-03-24T21:40:44.000Z" }]);
  });
});
```

Check `ai_usage_log`'s real columns first (`grep -n "CREATE TABLE IF NOT EXISTS ai_usage_log" -A15 apps/worker/src/db/migrations/019_absorb_runtime_ddl.sql`) and match the insert.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker && npx vitest run test/audit-api.test.ts`
Expected: FAIL; `/api/audit` returns 404.

- [ ] **Step 3: Write the router**

`apps/worker/src/routes/audit.ts`:

```ts
import { Hono } from "hono";
import type { Context } from "hono";
import { AuditWriteError, userSubjectId } from "@repo/audit";
import type { Bindings } from "../bindings.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { auditFor, auditRefused } from "../audit/context.js";
import { verifyRange } from "../audit/verify.js";

const audit = new Hono<{ Bindings: Bindings }>();
audit.use("*", authMiddleware, requireRole("developer"));

type Ctx = Context<{ Bindings: Bindings }>;
const PAGE = 50;
const EXPORT_MAX = 10_000;

interface Filters { where: string; binds: unknown[]; echo: Record<string, string> }

function filters(c: Ctx): Filters {
  const q = c.req.query();
  const where: string[] = [];
  const binds: unknown[] = [];
  const echo: Record<string, string> = {};
  const add = (key: string, sql: string, value: unknown) => {
    where.push(sql);
    binds.push(value);
    echo[key] = String(value);
  };
  if (q.shop_id) add("shop_id", "l.shop_id = ?", q.shop_id);
  if (q.actor) add("actor", "l.actor_ref = ?", q.actor.startsWith("subj_") ? q.actor : userSubjectId(q.actor));
  if (q.action) q.action.endsWith(".") ? add("action", "l.action LIKE ?", `${q.action}%`) : add("action", "l.action = ?", q.action);
  if (q.outcome) add("outcome", "l.outcome = ?", q.outcome);
  if (q.from) add("from", "l.occurred_at >= ?", q.from);
  if (q.to) add("to", "l.occurred_at <= ?", q.to);
  if (q.request_id) add("request_id", "l.request_id = ?", q.request_id);
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", binds, echo };
}

const SELECT = `SELECT l.*, a.display_name AS actor_name, a.email AS actor_email, a.redacted_at AS actor_redacted_at, ip.ip AS ip
  FROM audit_log l
  LEFT JOIN audit_subjects a ON a.id = l.actor_ref
  LEFT JOIN audit_subjects ip ON ip.id = l.ip_ref`;

async function guarded<T>(c: Ctx, fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
}

// GET /api/audit — filtered, newest first, cursor = "<occurred_at>|<id>"
audit.get("/", async (c) => {
  const f = filters(c);
  const cursor = c.req.query("cursor");
  let where = f.where;
  const binds = [...f.binds];
  if (cursor) {
    const [at, id] = cursor.split("|");
    where = `${where ? `${where} AND` : "WHERE"} (l.occurred_at < ? OR (l.occurred_at = ? AND l.id < ?))`;
    binds.push(at, at, id);
  }
  if (!cursor) {
    const refused = await guarded(c, () => auditFor(c).write({ action: "audit.view", outcome: "succeeded", details: { filters: f.echo } }));
    if (refused instanceof Response) return refused;
  }
  const rows = await c.env.DB.prepare(`${SELECT} ${where} ORDER BY l.occurred_at DESC, l.id DESC LIMIT ?`)
    .bind(...binds, PAGE + 1)
    .all<Record<string, unknown>>();
  const list = rows.results ?? [];
  const page = list.slice(0, PAGE).map((r) => ({ ...r, redacted: r.actor_redacted_at !== null && r.actor_redacted_at !== undefined }));
  const last = page[page.length - 1];
  return c.json({
    success: true,
    data: { entries: page, next_cursor: list.length > PAGE && last ? `${last.occurred_at}|${last.id}` : null },
  });
});

// POST /api/audit/verify — body { from_seq?, to_seq? }; default = the latest 1000 sealed entries
audit.post("/verify", async (c) => {
  const body = await c.req.json<{ from_seq?: number; to_seq?: number }>().catch(() => ({}) as { from_seq?: number; to_seq?: number });
  const max = (await c.env.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number | null }>())?.m ?? 0;
  const floor = ((await c.env.DB.prepare("SELECT expired_through_seq AS e FROM audit_seal_state WHERE id = 1").first<{ e: number }>())?.e ?? 0) + 1;
  const to = Math.min(Number.isInteger(body.to_seq) ? body.to_seq! : max, max);
  const from = Math.max(Number.isInteger(body.from_seq) ? body.from_seq! : to - 999, floor);
  if (to < from) return c.json({ success: true, data: { ok: true, fromSeq: from, toSeq: to, checked: 0, firstBadSeq: null, problem: null } });
  const result = await verifyRange(c.env.DB, c.env.AUDIT_ARCHIVE, from, to);
  const refused = await guarded(c, () =>
    auditFor(c).write({ action: "audit.verify", outcome: result.ok ? "succeeded" : "failed", reason: result.problem, details: { ...result } })
  );
  if (refused instanceof Response) return refused;
  return c.json({ success: true, data: result });
});

const CSV_HEADER = "occurred_at,seq,action,outcome,actor,actor_email,shop_id,entity_type,entity_id,changes,details,request_id,sealed,archived";
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// GET /api/audit/export?...&part=csv|proof
audit.get("/export", async (c) => {
  const f = filters(c);
  const part = c.req.query("part") === "proof" ? "proof" : "csv";
  const refused = await guarded(c, () => auditFor(c).write({ action: "audit.export", outcome: "succeeded", details: { part, filters: f.echo } }));
  if (refused instanceof Response) return refused;
  const rows = (
    await c.env.DB.prepare(`${SELECT} ${f.where} ORDER BY l.occurred_at, l.id LIMIT ?`).bind(...f.binds, EXPORT_MAX).all<Record<string, unknown>>()
  ).results ?? [];
  if (part === "csv") {
    const lines = rows.map((r) =>
      [r.occurred_at, r.seq, r.action, r.outcome, r.actor_name ?? r.actor_type, r.actor_email, r.shop_id, r.entity_type, r.entity_id,
        r.changes_json, r.details_json, r.request_id, r.sealed_at ? "yes" : "no", r.archived_at ? "yes" : "no"].map(csvCell).join(",")
    );
    return new Response([CSV_HEADER, ...lines].join("\n") + "\n", {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="audit-export.csv"' },
    });
  }
  const sealed = rows.filter((r) => typeof r.seq === "number").sort((a, b) => (a.seq as number) - (b.seq as number));
  const first = sealed[0] ?? null;
  const last = sealed[sealed.length - 1] ?? null;
  const archives = [...new Set(sealed.map((r) => r.archive_key).filter(Boolean))];
  const day = (r: Record<string, unknown> | null) => (r ? String(r.sealed_at).slice(0, 10) : null);
  return c.json({
    success: true,
    data: {
      generated_at: new Date().toISOString(),
      filters: f.echo,
      entries: rows.length,
      first: first && { seq: first.seq, chain_hash: first.chain_hash },
      last: last && { seq: last.seq, chain_hash: last.chain_hash },
      archive_objects: archives,
      anchors: [day(first), day(last)].filter(Boolean).map((d) => `anchors/${d}.json`),
      how_to_verify:
        "Recompute each entry's SHA-256 over its canonical fields, chain from the value before 'first', and compare with the archive objects and the emailed daily anchors.",
    },
  });
});

// GET /api/audit/subjects/:subjectId/export — subject access
audit.get("/subjects/:subjectId/export", async (c) => {
  const subjectId = c.req.param("subjectId");
  const subject = await c.env.DB.prepare("SELECT * FROM audit_subjects WHERE id = ?").bind(subjectId).first();
  if (!subject) return c.json({ success: false, error: "Subject not found" }, 404);
  const refused = await guarded(c, () =>
    auditFor(c).write({ action: "data.export", outcome: "succeeded", entityType: "audit_subject", entityId: subjectId })
  );
  if (refused instanceof Response) return refused;
  const entries = (
    await c.env.DB.prepare("SELECT * FROM audit_log WHERE actor_ref = ? OR ip_ref = ? ORDER BY occurred_at LIMIT ?")
      .bind(subjectId, subjectId, EXPORT_MAX)
      .all()
  ).results ?? [];
  return c.json({ success: true, data: { subject, entries } });
});

// POST /api/audit/subjects/:userId/erase — record an erasure request (blanking in 30 days)
audit.post("/subjects/:userId/erase", async (c) => {
  const subjectId = userSubjectId(c.req.param("userId"));
  const redactAfter = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const current = await c.env.DB.prepare("SELECT redact_after FROM audit_subjects WHERE id = ?").bind(subjectId).first<{ redact_after: string | null }>();
  if (!current) return c.json({ success: false, error: "Subject not found" }, 404);
  const stmts = await guarded(c, () =>
    auditFor(c).statements({
      action: "subject.erase_request",
      outcome: "succeeded",
      entityType: "audit_subject",
      entityId: subjectId,
      changes: { redact_after: [current.redact_after, redactAfter] },
    })
  );
  if (stmts instanceof Response) return stmts;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE audit_subjects SET redact_after = ? WHERE id = ? AND redacted_at IS NULL").bind(redactAfter, subjectId),
    ...stmts,
  ]);
  return c.json({ success: true, data: { redact_after: redactAfter } });
});

// POST /api/audit/import-historical — one-off, idempotent
audit.post("/import-historical", async (c) => {
  const rows = (
    await c.env.DB.prepare(
      `SELECT u.* FROM ai_usage_log u WHERE NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.id = 'hist_' || u.id) ORDER BY u.created_at LIMIT 500`
    ).all<Record<string, unknown>>()
  ).results ?? [];
  const system = (await import("../audit/context.js")).systemAudit(c.env.DB, "api", c.get("requestId") ?? null);
  for (const r of rows) {
    const created = String(r.created_at);
    const iso = created.includes("T") ? new Date(created).toISOString() : new Date(`${created.replace(" ", "T")}Z`).toISOString();
    await system.write({
      id: `hist_${r.id}`,
      occurredAt: iso,
      historical: true,
      action: "ai.call",
      outcome: "succeeded",
      shopId: (r.shop_id as string) ?? null,
      details: {
        worker: r.worker_name, model: r.model, usage_type: r.usage_type, input_tokens: r.input_tokens,
        output_tokens: r.output_tokens, estimated_cost_usd: r.estimated_cost_usd, job_id: r.job_id ?? null,
        note: "historical, not recorded at the time",
      },
    });
  }
  const refused = await guarded(c, () =>
    auditFor(c).write({ action: "audit.import.historical", outcome: "succeeded", details: { imported: rows.length } })
  );
  if (refused instanceof Response) return refused;
  return c.json({ success: true, data: { imported: rows.length, more: rows.length === 500 } });
});

export default audit;
```

Replace the dynamic `import("../audit/context.js")` in `/import-historical` with a static `systemAudit` import at the top of the file (it is shown dynamic above only to keep the snippet self-contained; use the static form).

Mount it in `src/index.ts` next to the AI router:

```ts
import auditRouter from "./routes/audit.js";
// ...
// Developer: audit trail viewer, checks and exports
app.route("/api/audit", auditRouter);
```

In `apps/worker/src/audit/registry.ts`, replace the comment line `// Task 11 adds the three /api/audit POST routes here.` with:

```ts
  "POST /api/audit/verify": "audit.verify",
  "POST /api/audit/import-historical": "audit.import.historical",
  "POST /api/audit/subjects/:userId/erase": "subject.erase_request",
```

(`PENDING_CEILING` is unchanged: these are instrumented, not pending.)

- [ ] **Step 4: Run the tests**

Run: `cd apps/worker && npx vitest run test/audit-api.test.ts test/audit-coverage.test.ts && npm test && npx tsc --noEmit`
Expected: 6 API tests pass; the coverage test is now fully green (the three `/api/audit` POST routes exist); full suite and tsc pass.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/routes/audit.ts apps/worker/src/index.ts apps/worker/test/audit-api.test.ts
aramid check --staged
git commit -m "feat(audit): developer API - list, verify, CSV + proof export, subject export, erasure request, history import"
```

---

### Task 12: Activity page on the developer dashboard

**Files:**
- Create: `apps/web/app/lib/audit.ts`, `apps/web/app/lib/audit.test.ts`
- Create: `apps/web/app/routes/dev.activity.tsx`, `apps/web/app/routes/dev.activity.export.tsx`
- Modify: `apps/web/app/components/dashboards/Sidebar.tsx` (developer nav)

**Interfaces:**
- Consumes: the Task 11 API.
- Produces: `/dev/activity` page; `/dev/activity/export?part=csv|proof&...` download route; helpers `auditQuery(params)`, `entryStatus(entry)`, `actionLabel(action)`.

- [ ] **Step 1: Write the failing helper tests**

`apps/web/app/lib/audit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { actionLabel, auditQuery, entryStatus } from "./audit";

describe("audit page helpers", () => {
  it("keeps only known filters", () => {
    const p = new URLSearchParams("shop_id=s1&action=site.&evil=1&cursor=c");
    expect(auditQuery(p)).toBe("shop_id=s1&action=site.&cursor=c");
  });
  it("derives the status badge", () => {
    expect(entryStatus({ sealed_at: null, archived_at: null })).toEqual({ label: "Pending", variant: "warning" });
    expect(entryStatus({ sealed_at: "x", archived_at: null })).toEqual({ label: "Sealed", variant: "default" });
    expect(entryStatus({ sealed_at: "x", archived_at: "y" })).toEqual({ label: "Archived", variant: "success" });
  });
  it("labels actions in plain words", () => {
    expect(actionLabel("site.pause")).toBe("Site paused");
    expect(actionLabel("brand.new")).toBe("brand.new");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run app/lib/audit.test.ts`
Expected: FAIL, cannot resolve `./audit`.

- [ ] **Step 3: Write the helpers**

`apps/web/app/lib/audit.ts`:

```ts
export const AUDIT_FILTERS = ["shop_id", "actor", "action", "outcome", "from", "to", "request_id", "cursor"] as const;

export function auditQuery(params: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const k of AUDIT_FILTERS) {
    const v = params.get(k);
    if (v) out.set(k, v);
  }
  return out.toString();
}

export function entryStatus(e: { sealed_at: string | null; archived_at: string | null }): {
  label: "Pending" | "Sealed" | "Archived";
  variant: "warning" | "default" | "success";
} {
  if (e.archived_at) return { label: "Archived", variant: "success" };
  if (e.sealed_at) return { label: "Sealed", variant: "default" };
  return { label: "Pending", variant: "warning" };
}

const LABELS: Record<string, string> = {
  "site.activate": "Site made live",
  "site.pause": "Site paused",
  "site.regenerate.request": "Site regeneration requested",
  "theme.generate": "Theme generated",
  "theme.apply": "Theme applied",
  "theme.compare": "Themes compared",
  "shop.delete": "Shop deleted",
  "ai.call": "AI call",
  "ai.chatbot_model.set": "Chatbot model changed",
  "audit.view": "Activity viewed",
  "audit.export": "Activity exported",
  "audit.verify": "Trail checked",
  "audit.gap": "Unlabelled change",
  "audit.expire": "Old entries expired",
  "audit.import.historical": "AI history imported",
  "subject.redact": "Personal details blanked",
  "subject.erase_request": "Erasure requested",
  "data.export": "Personal data exported",
};

export function actionLabel(action: string): string {
  return LABELS[action] ?? action;
}

export const ACTION_GROUPS: { value: string; label: string }[] = [
  { value: "", label: "All actions" },
  { value: "site.", label: "Website" },
  { value: "theme.", label: "Themes" },
  { value: "shop.", label: "Shops" },
  { value: "ai.", label: "AI" },
  { value: "audit.", label: "Audit trail" },
  { value: "subject.", label: "Personal data" },
];
```

- [ ] **Step 4: Write the page**

`apps/web/app/routes/dev.activity.tsx`:

```tsx
import { Form, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { ACTION_GROUPS, actionLabel, auditQuery, entryStatus } from "~/lib/audit";

interface Entry {
  id: string;
  occurred_at: string;
  seq: number | null;
  sealed_at: string | null;
  archived_at: string | null;
  action: string;
  phase: string;
  outcome: string | null;
  reason: string | null;
  actor_type: string;
  actor_ref: string | null;
  actor_name: string | null;
  actor_email: string | null;
  redacted: boolean;
  ip: string | null;
  shop_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  changes_json: string | null;
  details_json: string | null;
  request_id: string | null;
  historical: number;
}

interface VerifyResult { ok: boolean; checked: number; fromSeq: number; toSeq: number; firstBadSeq: number | null; problem: string | null }

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const api = createApiClient(env.API_URL, getSessionToken(request));
  const qs = auditQuery(new URL(request.url).searchParams);
  try {
    const data = await api.get<{ entries: Entry[]; next_cursor: string | null }>(`/api/audit${qs ? `?${qs}` : ""}`);
    return json({ ...data, error: null as string | null });
  } catch (e) {
    return json({ entries: [] as Entry[], next_cursor: null, error: e instanceof Error ? e.message : "Could not load activity" });
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const api = createApiClient(env.API_URL, getSessionToken(request));
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "verify") {
      const from = Number(form.get("from_seq")) || undefined;
      const to = Number(form.get("to_seq")) || undefined;
      return json({ verify: await api.post<VerifyResult>("/api/audit/verify", { from_seq: from, to_seq: to }), error: null });
    }
    if (intent === "import") {
      const r = await api.post<{ imported: number; more: boolean }>("/api/audit/import-historical");
      return json({ imported: r, error: null });
    }
    if (intent === "erase") {
      const userId = String(form.get("user_id") ?? "");
      return json({ erased: await api.post<{ redact_after: string }>(`/api/audit/subjects/${encodeURIComponent(userId)}/erase`), error: null });
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Request failed" });
  }
  return json({ error: "Unknown request" });
}

function Changes({ json: raw }: { json: string | null }) {
  if (!raw) return null;
  const changes = JSON.parse(raw) as Record<string, [unknown, unknown]>;
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {Object.entries(changes).map(([k, [before, after]]) => (
        <li key={k} className="break-words">
          <span className="text-white/50">{k}:</span> <span className="text-white/60 line-through">{String(before ?? "none")}</span>{" "}
          <span className="text-white">{String(after ?? "none")}</span>
        </li>
      ))}
    </ul>
  );
}

export default function DevActivity() {
  const { entries, next_cursor, error } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [params] = useSearchParams();
  const nav = useNavigation();
  const sealed = entries.filter((e) => e.seq !== null).map((e) => e.seq as number);
  const qs = auditQuery(params);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl text-white">Activity</h1>
          <p className="text-sm text-white/60">Every recorded change, AI call and data access. Entries can be added, never edited.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a className="tap-target inline-flex items-center rounded-md border border-white/20 px-3 py-2 text-sm text-white/80" href={`/dev/activity/export?part=csv${qs ? `&${qs}` : ""}`}>
            Export CSV
          </a>
          <a className="tap-target inline-flex items-center rounded-md border border-white/20 px-3 py-2 text-sm text-white/80" href={`/dev/activity/export?part=proof${qs ? `&${qs}` : ""}`}>
            Export proof
          </a>
          <Form method="post">
            <input type="hidden" name="intent" value="verify" />
            {sealed.length > 0 && (
              <>
                <input type="hidden" name="from_seq" value={Math.min(...sealed)} />
                <input type="hidden" name="to_seq" value={Math.max(...sealed)} />
              </>
            )}
            <Button type="submit" className="tap-target" disabled={nav.state !== "idle"}>Check now</Button>
          </Form>
        </div>
      </header>

      {result && "verify" in result && result.verify && (
        <p role="status" className={result.verify.ok ? "text-emerald-400" : "text-red-400"}>
          {result.verify.ok
            ? `Checked ${result.verify.checked} entries (${result.verify.fromSeq} to ${result.verify.toSeq}): the trail is intact.`
            : `Problem at entry ${result.verify.firstBadSeq}: ${result.verify.problem}`}
        </p>
      )}
      {result && "imported" in result && result.imported && (
        <p role="status" className="text-white/80">Imported {result.imported.imported} AI usage rows{result.imported.more ? "; run again for more." : "."}</p>
      )}
      {result && "erased" in result && result.erased && (
        <p role="status" className="text-white/80">Erasure recorded. Personal details will be blanked on {result.erased.redact_after.slice(0, 10)}.</p>
      )}
      {(error || (result && result.error)) && <p role="alert" className="text-red-400">{error ?? result?.error}</p>}

      <Form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Input name="shop_id" placeholder="Shop id" defaultValue={params.get("shop_id") ?? ""} aria-label="Shop id" />
        <Input name="actor" placeholder="Person (user id)" defaultValue={params.get("actor") ?? ""} aria-label="Person" />
        <select name="action" defaultValue={params.get("action") ?? ""} aria-label="Action" className="tap-target rounded-md border border-white/20 bg-transparent px-3 py-2 text-white">
          {ACTION_GROUPS.map((g) => <option key={g.value} value={g.value} className="bg-[#0D0D0D]">{g.label}</option>)}
        </select>
        <select name="outcome" defaultValue={params.get("outcome") ?? ""} aria-label="Outcome" className="tap-target rounded-md border border-white/20 bg-transparent px-3 py-2 text-white">
          <option value="" className="bg-[#0D0D0D]">Any outcome</option>
          <option value="succeeded" className="bg-[#0D0D0D]">Succeeded</option>
          <option value="failed" className="bg-[#0D0D0D]">Failed</option>
          <option value="refused" className="bg-[#0D0D0D]">Refused</option>
          <option value="unknown" className="bg-[#0D0D0D]">Unknown</option>
        </select>
        <Button type="submit" className="tap-target">Filter</Button>
      </Form>

      <ol className="space-y-2">
        {entries.length === 0 && <li className="text-white/60">No activity matches these filters.</li>}
        {entries.map((e) => {
          const status = entryStatus(e);
          const who = e.redacted ? "Redacted" : e.actor_name ?? e.actor_email ?? (e.actor_type === "system" ? "System" : e.actor_type === "anonymous" ? "Visitor" : e.actor_type);
          return (
            <li key={e.id} className="rounded-lg border border-white/10 bg-white/[0.02]">
              <details>
                <summary className="tap-target flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <time className="text-xs text-white/50" dateTime={e.occurred_at}>{new Date(e.occurred_at).toLocaleString("en-GB")}</time>
                  <span className="min-w-[9rem] flex-1 font-medium text-white">{actionLabel(e.action)}{e.phase === "started" ? " (started)" : ""}</span>
                  <span className="text-sm text-white/70">{who}</span>
                  {e.outcome && <Badge variant={e.outcome === "succeeded" ? "success" : e.outcome === "unknown" ? "warning" : "error"}>{e.outcome}</Badge>}
                  <Badge variant={status.variant} className="ml-auto">{status.label}</Badge>
                  {e.historical === 1 && <Badge variant="outline">Historical</Badge>}
                </summary>
                <div className="space-y-2 border-t border-white/10 px-4 py-3 text-sm text-white/70">
                  {e.reason && <p>Reason: {e.reason}</p>}
                  {e.shop_id && <p>Shop: <a className="underline" href={`/dev/activity?shop_id=${encodeURIComponent(e.shop_id)}`}>{e.shop_id}</a></p>}
                  {e.entity_type && <p>Item: {e.entity_type} {e.entity_id}</p>}
                  <Changes json={e.changes_json} />
                  {e.details_json && <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 text-xs">{JSON.stringify(JSON.parse(e.details_json), null, 2)}</pre>}
                  {e.request_id && <p><a className="tap-target underline" href={`/dev/activity?request_id=${encodeURIComponent(e.request_id)}`}>Everything from this request</a></p>}
                  {e.ip && !e.redacted && <p>IP: {e.ip}</p>}
                  {e.seq !== null && <p>Entry number {e.seq}</p>}
                  {e.actor_ref?.startsWith("subj_user_") && !e.redacted && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <a className="tap-target underline" href={`/dev/activity?actor=${encodeURIComponent(e.actor_ref)}`}>All activity by this person</a>
                      <a className="tap-target underline" href={`/dev/activity/export?subject=${encodeURIComponent(e.actor_ref)}`}>Export their data</a>
                      <Form method="post">
                        <input type="hidden" name="intent" value="erase" />
                        <input type="hidden" name="user_id" value={e.actor_ref.slice("subj_user_".length)} />
                        <Button type="submit" variant="ghost" className="tap-target">Record erasure request</Button>
                      </Form>
                    </div>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap justify-between gap-3">
        {next_cursor ? (
          <a className="tap-target underline" href={`/dev/activity?${auditQuery(new URLSearchParams({ ...Object.fromEntries(params), cursor: next_cursor }))}`}>Older entries</a>
        ) : <span />}
        <Form method="post">
          <input type="hidden" name="intent" value="import" />
          <Button type="submit" variant="ghost" className="tap-target">Import AI usage history</Button>
        </Form>
      </div>
    </div>
  );
}
```

Check `Button`'s variants in `apps/web/app/components/ui/Button.tsx`; if there is no `ghost`, use the variant the other dev pages use for secondary actions.

`apps/web/app/routes/dev.activity.export.tsx` (resource route, no default export):

```tsx
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { getSessionToken, requireRole } from "~/lib/auth";
import { auditQuery } from "~/lib/audit";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "developer", env.API_URL);
  const url = new URL(request.url);
  const token = getSessionToken(request);
  const subject = url.searchParams.get("subject");
  const upstream = subject
    ? `${env.API_URL}/api/audit/subjects/${encodeURIComponent(subject)}/export`
    : `${env.API_URL}/api/audit/export?part=${url.searchParams.get("part") === "proof" ? "proof" : "csv"}${auditQuery(url.searchParams) ? `&${auditQuery(url.searchParams)}` : ""}`;
  const res = await fetch(upstream, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const isCsv = (res.headers.get("Content-Type") ?? "").includes("text/csv");
  const filename = subject ? "personal-data-export.json" : isCsv ? "audit-export.csv" : "audit-proof.json";
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
```

In `Sidebar.tsx`, add `ScrollText` to the `lucide-react` import list and a developer nav item after AI Deploy:

```ts
  { href: "/dev/activity", label: "Activity", icon: ScrollText },
```

- [ ] **Step 5: Run the tests and type-check**

Run: `cd apps/web && npx vitest run app/lib/audit.test.ts && npx tsc && npm run build`
Expected: 3 passed; tsc clean; build succeeds. Confirm no `.js` twin exists for the new routes (`ls apps/web/app/routes/dev.activity*`).

- [ ] **Step 6: Visual check at phone width**

Follow the harness recipe in memory `dashboard-mobile-shell` (static SSR harness + Tailwind build + Playwright at 390px) or run the dev server with a seeded developer, and confirm at 390px: filters stack in one column, rows wrap without horizontal scroll, buttons meet the 44px tap target. Delete any temporary harness test before committing.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/lib/audit.ts apps/web/app/lib/audit.test.ts apps/web/app/routes/dev.activity.tsx apps/web/app/routes/dev.activity.export.tsx apps/web/app/components/dashboards/Sidebar.tsx
aramid check --staged
git commit -m "feat(dashboards): Activity page - audit trail viewer, checks, exports and erasure requests"
```

---

### Task 13: Deploy triggers, runbook and staging E2E

**Files:**
- Modify: `.github/workflows/deploy-worker.yml` (`paths`)
- Create: `docs/runbooks/audit-trail-rollout.md`
- Create: `tests/e2e/audit-trail.spec.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Fix the deploy trigger**

In `.github/workflows/deploy-worker.yml`, the `paths:` list becomes:

```yaml
    paths:
      - "apps/worker/**"
      - "apps/workers/booking/**"
      - "packages/types/**"
      - "packages/utils/**"
      - "packages/llm/**"
      - "packages/audit/**"
      - "package-lock.json"
      - ".github/workflows/deploy-worker.yml"
```

- [ ] **Step 2: Write the runbook**

`docs/runbooks/audit-trail-rollout.md`:

````markdown
# Audit trail rollout (Plan 1)

Spec: `docs/superpowers/specs/2026-09-26-audit-trail-design.md`. Run by the operator, in order.
Every command starts from `apps/worker`.

## 1. Create and lock the archive buckets (BEFORE merging)

The worker binds `AUDIT_ARCHIVE`; a deploy fails if the bucket does not exist.

```bash
npx wrangler r2 bucket create pivot-parlor-audit
npx wrangler r2 bucket lock add pivot-parlor-audit --name retain-6y --retention-days 2192
npx wrangler r2 bucket create pivot-parlor-audit-staging
npx wrangler r2 bucket lock add pivot-parlor-audit-staging --name retain-6y --retention-days 2192
npx wrangler r2 bucket lock list pivot-parlor-audit
```

Archive files expire at the same age as database entries (spec 6.2). Add a lifecycle rule a few days
past the lock (confirm the flag names first with `npx wrangler r2 bucket lifecycle add --help`; the
intent is "delete objects 2200 days after upload"):

```bash
npx wrangler r2 bucket lifecycle add pivot-parlor-audit expire-6y --expire-days 2200
npx wrangler r2 bucket lifecycle add pivot-parlor-audit-staging expire-6y --expire-days 2200
```

Anchor files (`anchors/`) are covered by the same rules.

A lock rule can be removed by anyone with account access. The daily anchor email is the copy that
protects against that; keep those emails.

## 2. Merge

CI applies migration 046 and deploys the API worker (the workflow now also triggers on
`package-lock.json` and `packages/audit/**`). Confirm the run finished green.

## 3. Verify

1. Sign in as developer, open **Activity**. Opening it writes an "Activity viewed" entry.
2. Pause and re-activate a test shop's site (not a live customer's). Two entries appear with
   before/after `website_status`.
3. Within two minutes both show **Sealed**, then **Archived**.
4. Press **Check now**: "the trail is intact".
5. `npx wrangler r2 object get pivot-parlor-audit/<archive_key> --remote --pipe | head -c 400`
   shows the entries.
6. Next morning: an email "Audit anchor <date>" arrives, and **Activity** shows a "Trail checked"
   entry from 03:00.

## 4. Import AI usage history (once)

Press **Import AI usage history** on the Activity page until it reports no more rows. Imported
entries are labelled **Historical**.

## Rollback

- Code: redeploy the previous worker version (`npx wrangler rollback`). The tables, archive and
  entries stay; nothing needs undoing.
- The buckets cannot be emptied while locked; that is intended.
````

- [ ] **Step 3: Write the staging E2E spec**

`tests/e2e/audit-trail.spec.ts`. First read an existing developer-authenticated spec in `tests/e2e/` and reuse its sign-in helper and its seeded test shop; do not create new login code. The spec:

```ts
import { expect, test } from "@playwright/test";
// Reuse the existing developer login helper and test-shop fixture from tests/e2e (import path per that file).

test("pausing a site is recorded, sealed and archived", async ({ page }) => {
  // 1. sign in as the E2E developer (existing helper)
  // 2. POST pause then activate for the E2E test shop through the dashboard UI (Shops page)
  await page.goto("/dev/activity?action=site.");
  await expect(page.getByText("Site paused").first()).toBeVisible();
  // Sealing runs every minute on staging.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Archived").first()).toBeVisible();
  }).toPass({ timeout: 150_000, intervals: [15_000] });
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByRole("status")).toContainText("intact");
});
```

Replace the two numbered comments with the exact calls from the existing helper file (read it first; the plan cannot name it without guessing). If no developer-login helper exists for staging E2E, stop and report instead of inventing credentials handling.

- [ ] **Step 4: Full verification**

Run from the repo root:

```bash
npm test > "$TEMP/audit-full-test.txt" 2>&1; echo "rc=$?"
npm run check-types > "$TEMP/audit-types.txt" 2>&1; echo "rc=$?"
```

Expected: both `rc=0`. Read the tail of each file; a non-zero rc is a failure regardless of what the tail shows.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy-worker.yml docs/runbooks/audit-trail-rollout.md tests/e2e/audit-trail.spec.ts
aramid check --staged
git commit -m "chore(audit): deploy triggers, rollout runbook and staging E2E for the audit trail"
```

- [ ] **Step 6: Hand off**

Report to the owner, in plain language: what shipped, the runbook's step 1 (buckets must exist before merging), that the branch is not pushed, and that Plans 2 and 3 remain (61 routes, 3 crons, 2 queues pending in the API worker; the background and booking workers not yet instrumented; `audit.gap` entries cover the API worker meanwhile).
