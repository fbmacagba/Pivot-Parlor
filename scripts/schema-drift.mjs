#!/usr/bin/env node
/**
 * Schema-drift guard: does a live D1 database's schema match the migrations?
 *
 * Usage:
 *   node scripts/schema-drift.mjs --remote                    # production
 *   node scripts/schema-drift.mjs --remote --db pivot-parlor-db-staging
 *   node scripts/schema-drift.mjs --live-json <file> [--db <name>]
 *        # offline: a `wrangler d1 execute --json` dump of
 *        # SELECT type, name, tbl_name, sql FROM sqlite_master
 *
 * Production's schema differed from the chain three times (the P14 index, the
 * ai_usage_log CHECK, the reviews CASCADE), each invisible to tests, because
 * the suites replay the chain and production was baselined. This compares the
 * live sqlite_master with apps/worker/src/db/chain-schema.json, the chain as
 * the worker suite replays it (that test keeps the file current), and accepts
 * only the differences apps/worker/src/db/schema-drift-allowlist.json records
 * for that database, exactly as recorded. Column order is never compared.
 *
 * Read-only: one SELECT on sqlite_master and one on schema_migrations.
 * Exit 0: matches. Exit 1: drift, a stale allowlist entry, or a migration
 * mismatch. Exit 2: the database could not be read.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAllowlist, compareSchemas, describeSchema, migrationState } from "./schema-compare.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "apps", "worker");
const dbDir = path.join(workerDir, "src", "db");
const wranglerBin = path.join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? "";
};
const remote = args.includes("--remote");
const dbName = flag("--db") ?? "pivot-parlor-db";
const liveJson = flag("--live-json");

const REFRESH_HINT =
  "The chain side is apps/worker/src/db/chain-schema.json. After adding a migration, refresh it:\n" +
  "  cd apps/worker && npx vitest run test/schema-drift.test.ts -u";

function readLive() {
  if (liveJson !== null) {
    const parsed = JSON.parse(readFileSync(path.resolve(liveJson), "utf8"));
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => r.results ?? []);
    return { rows, applied: null, source: `file ${liveJson}` };
  }
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [
        wranglerBin, "d1", "execute", dbName, remote ? "--remote" : "--local", "--json", "--command",
        "SELECT type, name, tbl_name, sql FROM sqlite_master; SELECT name FROM schema_migrations",
      ],
      { cwd: workerDir, encoding: "utf8" }
    );
  } catch (err) {
    console.error(`✗ Could not read ${dbName}:\n${String(err.stdout ?? "")}${String(err.stderr ?? "")}${err.message}`);
    process.exit(2);
  }
  const sets = JSON.parse(out);
  return { rows: sets[0]?.results ?? [], applied: (sets[1]?.results ?? []).map((r) => r.name), source: remote ? "remote" : "local" };
}

const live = readLive();
console.log(`Schema drift check: ${dbName} (${live.source})`);

// Migration names first: a database that ran a migration this branch lacks
// (on staging, an unmerged PR's), or one this branch has but the database has
// not run, would otherwise show up as a confusing schema diff.
if (live.applied === null) {
  console.log("  migration-name check skipped (offline input)");
} else {
  const files = readdirSync(path.join(dbDir, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const expected = ["000_schema", ...files.map((f) => f.replace(/\.sql$/, ""))];
  const { pending, unknown } = migrationState(live.applied, expected);
  if (unknown.length) {
    console.error(
      `✗ ${dbName} has run migrations this branch does not have: ${unknown.join(", ")}\n` +
        "  Merge or rebase onto the branch that adds them. On staging this also happens when\n" +
        "  another pull request's migration was applied there and has not been merged."
    );
    process.exit(1);
  }
  if (pending.length) {
    console.error(`✗ ${dbName} has not run ${pending.join(", ")}. Run scripts/migrate.mjs first.`);
    process.exit(1);
  }
}

const chain = JSON.parse(readFileSync(path.join(dbDir, "chain-schema.json"), "utf8"));
const allowlists = JSON.parse(readFileSync(path.join(dbDir, "schema-drift-allowlist.json"), "utf8"));
if (!(dbName in allowlists)) console.log(`  no allowlist section for ${dbName}: every difference counts`);

const liveDescription = describeSchema(live.rows);
const differences = compareSchemas(liveDescription, chain);
const { allowed, unexpected, stale } = checkAllowlist(differences, allowlists[dbName] ?? []);
const objects = ["tables", "indexes", "triggers", "views"].reduce((n, k) => n + Object.keys(liveDescription[k]).length, 0);
console.log(`  ${objects} objects compared; ${allowed.length} known difference(s) allowed by schema-drift-allowlist.json`);

const show = (v) => (v === null ? "(absent)" : v);
if (unexpected.length) {
  console.error(`✗ ${unexpected.length} unexpected difference(s) between ${dbName} and the migrations:`);
  for (const d of unexpected) console.error(`  ${d.key}\n    live : ${show(d.live)}\n    chain: ${show(d.chain)}`);
}
if (stale.length) {
  console.error(
    `✗ ${stale.length} allowlist entr${stale.length === 1 ? "y no longer matches" : "ies no longer match"} ${dbName}` +
      " (fix the database, or update schema-drift-allowlist.json):"
  );
  for (const e of stale) console.error(`  ${e.key}\n    recorded live : ${show(e.live)}\n    recorded chain: ${show(e.chain)}`);
}
if (unexpected.length || stale.length) {
  console.error(REFRESH_HINT);
  process.exit(1);
}
console.log("✓ The schema matches the migrations.");
