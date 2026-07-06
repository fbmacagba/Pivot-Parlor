/**
 * Test setup: replay the MAIN worker's full migration chain (schema.sql +
 * migrations/) against the per-file simulated D1 database. The main worker's
 * chain is the canonical schema owner (CLAUDE.md) — this worker's tests run
 * against exactly what production replays, so a booking-worker query that
 * references a dropped legacy column fails here instead of in prod.
 */
import { env } from "cloudflare:test";
import { beforeAll } from "vitest";
import schemaSql from "../../../worker/src/db/schema.sql?raw";

const migrationModules = import.meta.glob("../../../worker/src/db/migrations/*.sql", {
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

beforeAll(async () => {
  for (const stmt of statements(schemaSql)) {
    await env.DB.prepare(stmt).run();
  }

  const files = Object.keys(migrationModules).sort();
  for (const file of files) {
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
