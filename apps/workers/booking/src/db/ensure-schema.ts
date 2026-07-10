/**
 * Runtime DDL for booking worker (no changes to repo migrations).
 * Safe to run repeatedly: IF NOT EXISTS / column checks.
 */
import type { D1Database } from "@cloudflare/workers-types";

let schemaReady: Promise<void> | null = null;

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
    console.error(`[booking] ALTER ${table} ADD ${name} failed`, e);
  }
}

export async function ensureBookingSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS shop_settings (
        shop_id TEXT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
        instagram_url TEXT DEFAULT '',
        show_instagram INTEGER NOT NULL DEFAULT 0,
        facebook_url TEXT DEFAULT '',
        show_facebook INTEGER NOT NULL DEFAULT 0,
        tiktok_url TEXT DEFAULT '',
        show_tiktok INTEGER NOT NULL DEFAULT 0,
        twitter_url TEXT DEFAULT '',
        show_twitter INTEGER NOT NULL DEFAULT 0,
        youtube_url TEXT DEFAULT '',
        show_youtube INTEGER NOT NULL DEFAULT 0,
        whatsapp_url TEXT DEFAULT '',
        show_whatsapp INTEGER NOT NULL DEFAULT 0,
        linkedin_url TEXT DEFAULT '',
        show_linkedin INTEGER NOT NULL DEFAULT 0,
        commission_bearer TEXT NOT NULL DEFAULT 'shop',
        product_commission_enabled INTEGER NOT NULL DEFAULT 0
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bw_availability (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        slot_date TEXT NOT NULL,
        slot_time TEXT NOT NULL,
        is_booked INTEGER NOT NULL DEFAULT 0,
        booking_id TEXT,
        UNIQUE (staff_id, slot_date, slot_time)
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bw_business_days (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        status TEXT NOT NULL,
        opened_at TEXT,
        closed_at TEXT,
        summary_json TEXT,
        performance_json TEXT,
        UNIQUE (shop_id, date)
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bw_booking_items (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        item_type TEXT NOT NULL,
        service_id TEXT,
        name TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_price_pence INTEGER NOT NULL DEFAULT 0,
        total_price_pence INTEGER NOT NULL DEFAULT 0,
        is_commissionable INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bw_transactions (
        id TEXT PRIMARY KEY,
        booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
        shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        amount_pence INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        stripe_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bw_commission_ledger (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        business_day_id TEXT REFERENCES bw_business_days(id) ON DELETE SET NULL,
        booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
        services_amount_pence INTEGER NOT NULL DEFAULT 0,
        commission_rate REAL NOT NULL DEFAULT 0.10,
        commission_amount_pence INTEGER NOT NULL DEFAULT 0,
        commission_bearer TEXT NOT NULL,
        stripe_transfer_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bw_platform_alerts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        shop_id TEXT REFERENCES shops(id) ON DELETE CASCADE,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bw_booking_state (
        booking_id TEXT PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
        shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        booking_type TEXT NOT NULL DEFAULT 'online',
        deposit_amount_pence INTEGER NOT NULL DEFAULT 0,
        stripe_payment_intent_id TEXT,
        promo_code TEXT,
        promo_discount_percent REAL,
        qr_code_data TEXT,
        checked_in_at TEXT,
        slot_time TEXT,
        workflow_flag TEXT,
        total_amount_pence INTEGER,
        stripe_balance_pi TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    .run();

  await tryAddColumn(db, "shops", "setup_completed", "INTEGER NOT NULL DEFAULT 0");
  await tryAddColumn(db, "shops", "stripe_connect_onboarded", "INTEGER NOT NULL DEFAULT 0");
  await tryAddColumn(db, "shops", "stripe_connect_account_id", "TEXT");
  await tryAddColumn(db, "shops", "operational_status", "TEXT NOT NULL DEFAULT 'closed'");

  await tryAddColumn(db, "shop_settings", "address", "TEXT");
  await tryAddColumn(db, "shop_settings", "hours_json", "TEXT");
  await tryAddColumn(db, "shop_settings", "sells_products", "INTEGER NOT NULL DEFAULT 0");
  await tryAddColumn(db, "shop_settings", "promo_discount_code", "TEXT");
  await tryAddColumn(db, "shop_settings", "promo_discount_percent", "REAL");

  await tryAddColumn(db, "services", "service_type", "TEXT NOT NULL DEFAULT 'service'");
}

export function withSchema<T extends { DB: D1Database }>(env: T, fn: () => Promise<Response> | Response): Promise<Response> {
  if (!schemaReady) {
    // Clear on rejection so the next request retries instead of replaying
    // the cached failure until the isolate restarts.
    schemaReady = ensureBookingSchema(env.DB).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady.then(() => fn()) as Promise<Response>;
}
