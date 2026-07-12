#!/usr/bin/env node
/**
 * D1 migration runner with tracking (schema_migrations), a Time Travel
 * safety bookmark, and baseline support.
 *
 * Usage:
 *   node scripts/migrate.mjs                 # local D1 (miniflare state)
 *   node scripts/migrate.mjs --remote        # production D1
 *   node scripts/migrate.mjs --remote --db pivot-parlor-db-staging
 *   node scripts/migrate.mjs --remote --baseline   # one-time adoption: mark all
 *                                                  # migrations applied WITHOUT running
 *   node scripts/migrate.mjs --dry-run       # show pending, change nothing
 *
 * Semantics:
 *  - Migration list = 000_schema (apps/worker/src/db/schema.sql) + sorted
 *    apps/worker/src/db/migrations/*.sql.
 *  - Snapshot overlap: schema.sql is a rolling snapshot and migrations are
 *    deltas, so a FRESH replay (empty database) legitimately re-applies DDL
 *    the snapshot already contains. On fresh replays exactly two error
 *    classes are benign no-ops: "duplicate column name" and "already exists".
 *  - Strict ratchet (WS-8): on an INCREMENTAL run (the database already has
 *    migration history) files numbered above 042 treat those same errors as
 *    HARD failures. The ensure-schema files are assert-only since WS-8, so
 *    nothing legitimately pre-creates schema on a tracked database — a
 *    collision means drift (hand-run DDL, or a re-run of a half-applied
 *    file) and a human must reconcile before continuing.
 *  - Time Travel bookmark (WS-8): --remote runs capture a bookmark before
 *    applying anything and print the exact restore command on failure.
 *    Restore is destructive and in-place — it also discards user writes made
 *    AFTER the bookmark — so it is never run automatically; forward-fixing
 *    is usually safer on a live database. See docs/DR-RUNBOOK.md.
 *  - Refuses to replay onto a database that has tables but no migration
 *    history — run --baseline once on such databases (e.g. production).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "apps", "worker");
const schemaPath = path.join(workerDir, "src", "db", "schema.sql");
const migrationsDir = path.join(workerDir, "src", "db", "migrations");

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const baseline = args.includes("--baseline");
const dryRun = args.includes("--dry-run");
const dbFlag = args.indexOf("--db");
const dbName = dbFlag !== -1 ? args[dbFlag + 1] : "pivot-parlor-db";

const BENIGN = /duplicate column name|already exists/i;

// Files numbered above this apply strictly on incremental runs (WS-8).
// Everything up to and including it predates the assert-only ensure-schema
// conversion, when runtime DDL could legitimately race the chain.
const STRICT_AFTER = 42;

// A migration file may declare (WS-4 pence conversion pattern):
//   -- replay-guard: skip-if-column-absent <table>.<column>
// If the named column does not exist, the file's work is already reflected in
// the schema (fresh replay from the snapshot, or the file already ran) and it
// is recorded as applied WITHOUT executing. This lets a data migration
// reference columns it later drops while the chain stays replayable.
// A missing table also skips (nothing to convert).
const GUARD_RE = /^--\s*replay-guard:\s*skip-if-column-absent\s+([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*$/m;

// Invoke wrangler's JS entry directly with node — avoids npx/.cmd shell
// quoting differences on Windows that split SQL into separate args.
const wranglerBin = path.join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");

function wranglerJson(sql) {
  const out = execFileSync(
    process.execPath,
    [
      wranglerBin, "d1", "execute", dbName,
      remote ? "--remote" : "--local",
      "--json", "--command", sql,
    ],
    { cwd: workerDir, encoding: "utf8" }
  );
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

/** Pre-flight Time Travel bookmark for remote runs. Restore-by-bookmark is
 *  the recovery path when a migration fails mid-file; capture failure is a
 *  warning, not an error — a restore-by-timestamp fallback always exists. */
function captureBookmark() {
  try {
    const out = execFileSync(
      process.execPath,
      [wranglerBin, "d1", "time-travel", "info", dbName, "--json"],
      { cwd: workerDir, encoding: "utf8" }
    );
    const m = out.match(/"bookmark":\s*"([0-9a-f-]+)"/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function printRestoreGuidance(bookmark, startedAtIso) {
  console.error("\n─── Recovery (WS-8) ─────────────────────────────────────────────");
  console.error("The database may be mid-migration. To roll back to the pre-run state:");
  if (bookmark) {
    console.error(`  npx wrangler d1 time-travel restore ${dbName} --bookmark=${bookmark}`);
  } else {
    console.error(`  npx wrangler d1 time-travel restore ${dbName} --timestamp="${startedAtIso}"`);
    console.error("  (no bookmark was captured — timestamp restore, run from apps/worker)");
  }
  console.error(
    "WARNING: restore is destructive and in-place; it ALSO discards user writes\n" +
      "made after that point. On a live database prefer fixing forward.\n" +
      "Full procedure: docs/DR-RUNBOOK.md."
  );
  console.error("──────────────────────────────────────────────────────────────────");
}

function migrationNumber(name) {
  const m = name.match(/^(\d+)_/);
  return m ? Number(m[1]) : null;
}

function statements(sql) {
  // Strip comment lines FIRST — a ';' inside a comment would otherwise split
  // the file mid-comment and corrupt the following statement.
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function applyFile(name, sql, strict) {
  let applied = 0;
  let skipped = 0;
  for (const stmt of statements(sql)) {
    try {
      wranglerJson(stmt);
      applied++;
    } catch (err) {
      const msg = String(err.stdout ?? "") + String(err.stderr ?? "") + String(err.message ?? "");
      if (BENIGN.test(msg) && !strict) {
        skipped++;
        console.log(`    ⚠ benign-skip: ${stmt.slice(0, 80).replace(/\s+/g, " ")}`);
        continue;
      }
      if (BENIGN.test(msg) && strict) {
        console.error(
          `\n✗ ${name}: "${msg.match(BENIGN)?.[0]}" on an INCREMENTAL run is treated as drift (file > 0${STRICT_AFTER}).\n` +
            `Statement: ${stmt.slice(0, 300)}\n` +
            `Likely causes: hand-run DDL on this database, or a re-run of a half-applied\n` +
            `file. Reconcile manually: verify the schema shape, then either restore to the\n` +
            `pre-run bookmark or record the file as applied with an INSERT INTO\n` +
            `schema_migrations once you have confirmed every statement's effect exists.`
        );
        throw err;
      }
      console.error(`\n✗ ${name} failed on statement:\n${stmt.slice(0, 300)}\n`);
      throw err;
    }
  }
  const skipNote = skipped > 0 ? `, ${skipped} benign no-ops` : "";
  console.log(`  ✓ ${name} (${applied} statements${skipNote})`);
}

// ── Build migration list ─────────────────────────────────────────────────────
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const all = [
  { name: "000_schema", sql: () => readFileSync(schemaPath, "utf8") },
  ...files.map((f) => ({
    name: f.replace(/\.sql$/, ""),
    sql: () => readFileSync(path.join(migrationsDir, f), "utf8"),
  })),
];

// ── Tracking table + applied set ────────────────────────────────────────────
console.log(`Database: ${dbName} (${remote ? "remote" : "local"})`);
wranglerJson(
  "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
);
const appliedRows = wranglerJson("SELECT name FROM schema_migrations");
const appliedSet = new Set(appliedRows.map((r) => r.name));
const pending = all.filter((m) => !appliedSet.has(m.name));

// Fresh replay = empty history: snapshot overlap is expected and benign
// swallowing applies to the whole chain. Incremental = strict for new files.
const freshReplay = appliedSet.size === 0;

if (pending.length === 0) {
  console.log("Nothing to do — all migrations recorded.");
  process.exit(0);
}

// ── Baseline mode ────────────────────────────────────────────────────────────
if (baseline) {
  if (dryRun) {
    console.log(`[dry-run] would baseline: ${pending.map((m) => m.name).join(", ")}`);
    process.exit(0);
  }
  for (const m of pending) {
    wranglerJson(`INSERT OR IGNORE INTO schema_migrations (name) VALUES ('${m.name}')`);
  }
  console.log(`Baselined ${pending.length} migration(s) without executing them.`);
  process.exit(0);
}

// ── Safety: never replay onto an untracked existing database ────────────────
if (freshReplay) {
  const existing = wranglerJson(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='shops'"
  );
  if (existing.length > 0) {
    console.error(
      "This database already has tables but no migration history.\n" +
        "Run once with --baseline to adopt it, then re-run normally."
    );
    process.exit(1);
  }
}

// ── Apply pending ────────────────────────────────────────────────────────────
console.log(`Pending: ${pending.map((m) => m.name).join(", ")}`);
if (dryRun) process.exit(0);

const startedAtIso = new Date().toISOString();
let bookmark = null;
if (remote) {
  bookmark = captureBookmark();
  if (bookmark) {
    console.log(`Time Travel bookmark (pre-run restore point): ${bookmark}`);
  } else {
    console.warn(
      `⚠ Could not capture a Time Travel bookmark — if recovery is needed, restore\n` +
        `  by timestamp instead: --timestamp="${startedAtIso}"`
    );
  }
}

function guardSaysSkip(sql) {
  const m = sql.match(GUARD_RE);
  if (!m) return false;
  const [, table, column] = m;
  const cols = wranglerJson(`PRAGMA table_info(${table})`);
  return !cols.some((c) => c.name === column);
}

try {
  for (const m of pending) {
    const sql = m.sql();
    const num = migrationNumber(m.name);
    const strict = !freshReplay && num !== null && num > STRICT_AFTER;
    if (guardSaysSkip(sql)) {
      console.log(`  ↷ ${m.name} skipped by replay-guard (schema already at target shape)`);
    } else {
      applyFile(m.name, sql, strict);
    }
    wranglerJson(`INSERT INTO schema_migrations (name) VALUES ('${m.name}')`);
  }
} catch (err) {
  if (remote) printRestoreGuidance(bookmark, startedAtIso);
  throw err;
}
console.log(`Done — applied ${pending.length} migration(s).`);
