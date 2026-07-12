/**
 * Schema assertions for the chatbot worker (WS-8, assert-only).
 *
 * This file used to CREATE tables and ALTER in columns at runtime as a
 * "defensive idempotent duplicate" of the canonical chain. Migration 019
 * absorbed that DDL into apps/worker/src/db/migrations, so this file now
 * only ASSERTS the shape and fails loudly. The fix for a failure here is
 * applying migrations (node scripts/migrate.mjs [--remote]) — never
 * runtime DDL.
 */
import type { D1Database } from "@cloudflare/workers-types";

/** Tables this worker touches; listed columns are the drift-prone ones the
 *  old runtime DDL used to add. An empty list asserts table existence only. */
const REQUIRED: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["chat_sessions", []],
  ["ai_usage_log", []],
  ["shop_settings", ["promo_active"]],
];

/** Throws (naming every missing table/column) when the database has not had
 *  the canonical migrations applied. One batched round trip. */
export async function assertChatbotSchema(db: D1Database): Promise<void> {
  const results = await db.batch<{ name: string }>(
    REQUIRED.map(([table]) => db.prepare(`PRAGMA table_info(${table})`))
  );
  const missing: string[] = [];
  REQUIRED.forEach(([table, columns], i) => {
    const rows = results[i]?.results ?? [];
    if (rows.length === 0) {
      missing.push(`${table} (table)`);
      return;
    }
    const have = new Set(rows.map((r) => r.name));
    for (const col of columns) {
      if (!have.has(col)) missing.push(`${table}.${col}`);
    }
  });
  if (missing.length > 0) {
    throw new Error(
      `[chatbot] D1 schema out of date — missing: ${missing.join(", ")}. ` +
        `Apply the canonical migrations (node scripts/migrate.mjs) — do not add runtime DDL.`
    );
  }
}
