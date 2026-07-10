/**
 * Test setup: replay the full migration chain (schema.sql + migrations/)
 * against the per-file simulated D1 database — the same semantics as
 * scripts/migrate.mjs, so every test run proves the chain stays replayable.
 *
 * schema.sql is a rolling snapshot and old migrations are deltas, so exactly
 * two error classes are benign no-ops ("duplicate column name", "already
 * exists"); anything else fails the suite.
 */
import { env } from "cloudflare:test";
import { beforeAll } from "vitest";
import schemaSql from "../src/db/schema.sql?raw";

const migrationModules = import.meta.glob("../src/db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function statements(sql: string): string[] {
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

const BENIGN = /duplicate column name|already exists/i;

// "-- replay-guard: skip-if-column-absent <table>.<column>" — same semantics
// as scripts/migrate.mjs: when the named column is gone the file's work is
// already reflected in the snapshot, so the whole file is skipped.
const GUARD_RE = /^--\s*replay-guard:\s*skip-if-column-absent\s+([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*$/m;

async function guardSaysSkip(sql: string): Promise<boolean> {
  const m = sql.match(GUARD_RE);
  if (!m) return false;
  const info = await env.DB.prepare(`PRAGMA table_info(${m[1]})`).all<{ name: string }>();
  return !(info.results ?? []).some((row) => row.name === m[2]);
}

beforeAll(async () => {
  for (const stmt of statements(schemaSql)) {
    await env.DB.prepare(stmt).run();
  }

  const files = Object.keys(migrationModules).sort();
  for (const file of files) {
    if (await guardSaysSkip(migrationModules[file]!)) continue;
    for (const stmt of statements(migrationModules[file]!)) {
      try {
        await env.DB.prepare(stmt).run();
      } catch (err) {
        if (BENIGN.test(String(err))) continue;
        throw new Error(`Migration ${file} is no longer replayable: ${String(err)}\nStatement: ${stmt.slice(0, 200)}`);
      }
    }
  }
});
