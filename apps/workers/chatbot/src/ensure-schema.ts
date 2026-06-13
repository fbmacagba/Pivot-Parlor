import type { D1Database } from "@cloudflare/workers-types";

async function columnExists(db: D1Database, table: string, col: string): Promise<boolean> {
  const r = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const rows =
    r && typeof r === "object" && "results" in r && Array.isArray((r as { results: { name: string }[] }).results)
      ? (r as { results: { name: string }[] }).results
      : [];
  return rows.some((row) => row.name === col);
}

async function tryAddColumn(db: D1Database, table: string, name: string, ddl: string): Promise<void> {
  if (await columnExists(db, table, name)) return;
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`).run();
  } catch (e) {
    console.error(`[chatbot] ALTER ${table} ADD ${name} failed`, e);
  }
}

export async function ensureChatbotSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        visitor_id TEXT NOT NULL,
        messages_json TEXT NOT NULL DEFAULT '[]',
        booking_initiated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ai_usage_log (
        id TEXT PRIMARY KEY,
        shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
        worker_name TEXT NOT NULL,
        model TEXT NOT NULL,
        usage_type TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        job_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    .run();

  await tryAddColumn(db, "shop_settings", "promo_active", "INTEGER NOT NULL DEFAULT 0");
}

let schemaReady: Promise<void> | null = null;

export function withChatbotSchema<T extends { DB: D1Database }>(env: T, fn: () => Promise<Response>): Promise<Response> {
  if (!schemaReady) {
    // Clear on rejection so the next request retries instead of replaying
    // the cached failure until the isolate restarts.
    schemaReady = ensureChatbotSchema(env.DB).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady.then(() => fn());
}
