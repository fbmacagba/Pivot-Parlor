/**
 * Test setup: replay the MAIN worker's full migration chain (schema.sql +
 * migrations/) against the per-file simulated D1 database. The main worker's
 * chain is the canonical schema owner (CLAUDE.md), including shop_sites
 * (migration-only) and shop_site_candidates (migration 049), so the
 * assembler's writes run here against exactly what production replays.
 * Same pattern as the booking worker.
 */
import { env } from "cloudflare:test";
import { beforeAll } from "vitest";
import schemaSql from "../../../worker/src/db/schema.sql?raw";
import { statements } from "../../../../scripts/sql-statements.mjs";

const migrationModules = import.meta.glob("../../../worker/src/db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const BENIGN = /duplicate column name|already exists/i;

// "-- replay-guard: skip-if-column-absent <table>.<column>": same semantics
// as scripts/migrate.mjs. When the named column is gone the file's work is
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
