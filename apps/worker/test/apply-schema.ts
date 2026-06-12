/**
 * Test setup: apply the base schema (strict) and all migrations (lenient)
 * to the per-file simulated D1 database.
 *
 * Migrations are applied statement-by-statement with failures tolerated
 * because the current migration chain is not replayable from scratch
 * (e.g. 016 ALTERs shop_settings, which no migration creates — tracked
 * as T5.1-T5.3 in the remediation plan). Once migration integrity lands,
 * make this strict.
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
  return sql
    .split(";")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter((s) => s.length > 0);
}

beforeAll(async () => {
  for (const stmt of statements(schemaSql)) {
    await env.DB.prepare(stmt).run();
  }

  const files = Object.keys(migrationModules).sort();
  for (const file of files) {
    for (const stmt of statements(migrationModules[file]!)) {
      try {
        await env.DB.prepare(stmt).run();
      } catch {
        // Tolerated until the migration chain is replayable (T5.1-T5.3).
      }
    }
  }
});
