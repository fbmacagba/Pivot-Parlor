#!/usr/bin/env node
/**
 * D1 migration runner with tracking (schema_migrations) and baseline support.
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
 *  - schema.sql is a rolling snapshot and old migrations are deltas, so a
 *    fresh replay can re-apply DDL the snapshot already contains. Statements
 *    are executed one-by-one and exactly two error classes are treated as
 *    benign no-ops: "duplicate column name" and "already exists". Anything
 *    else aborts.
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

function applyFile(name, sql) {
  let applied = 0;
  let skipped = 0;
  for (const stmt of statements(sql)) {
    try {
      wranglerJson(stmt);
      applied++;
    } catch (err) {
      const msg = String(err.stdout ?? "") + String(err.stderr ?? "") + String(err.message ?? "");
      if (BENIGN.test(msg)) {
        skipped++;
        continue;
      }
      console.error(`\n✗ ${name} failed on statement:\n${stmt.slice(0, 300)}\n`);
      throw err;
    }
  }
  console.log(`  ✓ ${name} (${applied} statements, ${skipped} benign no-ops)`);
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
if (appliedSet.size === 0) {
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

function guardSaysSkip(sql) {
  const m = sql.match(GUARD_RE);
  if (!m) return false;
  const [, table, column] = m;
  const cols = wranglerJson(`PRAGMA table_info(${table})`);
  return !cols.some((c) => c.name === column);
}

for (const m of pending) {
  const sql = m.sql();
  if (guardSaysSkip(sql)) {
    console.log(`  ↷ ${m.name} skipped by replay-guard (schema already at target shape)`);
  } else {
    applyFile(m.name, sql);
  }
  wranglerJson(`INSERT INTO schema_migrations (name) VALUES ('${m.name}')`);
}
console.log(`Done — applied ${pending.length} migration(s).`);
