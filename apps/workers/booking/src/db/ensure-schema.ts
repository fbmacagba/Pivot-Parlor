/**
 * Schema assertions for the booking worker (WS-8, assert-only).
 *
 * This file used to CREATE/ALTER missing tables at runtime as a "defensive
 * idempotent duplicate" of the canonical chain. That masked drift: a database
 * that missed a migration got whatever shape the first-woken worker wrote,
 * and canonical migrations then hit benign-looking "duplicate column" errors.
 * Migration 019 absorbed all of that DDL into the canonical chain
 * (apps/worker/src/db/migrations), so this file now only ASSERTS the shape
 * and fails loudly. The fix for a failure here is applying migrations
 * (node scripts/migrate.mjs [--remote]) — never runtime DDL.
 */
import type { D1Database } from "@cloudflare/workers-types";

/** Tables this worker touches. The listed columns are the drift-prone ones —
 *  exactly the set the old runtime DDL used to add after each table's
 *  original CREATE (connect/deposit/pence columns). An empty list asserts
 *  table existence only. */
const REQUIRED: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["shops", ["setup_completed", "stripe_connect_onboarded", "stripe_connect_account_id", "operational_status"]],
  [
    "shop_settings",
    [
      "commission_bearer",
      "address",
      "hours_json",
      "sells_products",
      "promo_discount_code",
      "promo_discount_percent",
      "deposits_enabled",
      "deposit_percent",
      "deposit_min_pence",
    ],
  ],
  ["services", ["service_type"]],
  ["bw_availability", []],
  ["bw_business_days", []],
  ["bw_transactions", ["amount_pence"]],
  ["bw_commission_ledger", ["services_amount_pence", "commission_amount_pence"]],
  ["bw_platform_alerts", []],
  [
    "bw_booking_state",
    [
      "deposit_amount_pence",
      "total_amount_pence",
      "stripe_checkout_session_id",
      "deposit_paid_at",
      "deposit_application_fee_pence",
    ],
  ],
];

/** Throws (naming every missing table/column) when the database has not had
 *  the canonical migrations applied. One batched round trip. */
export async function assertBookingSchema(db: D1Database): Promise<void> {
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
      `[booking] D1 schema out of date — missing: ${missing.join(", ")}. ` +
        `Apply the canonical migrations (node scripts/migrate.mjs) — do not add runtime DDL.`
    );
  }
  await assertNotNullColumn(db, "bookings", "status");
}

const IDENTIFIER = /^[a-z_]+$/;

/** Throws unless `table.column` exists and is declared NOT NULL. The deposit
 *  cancel guard (cancelPendingBookingStmts) writes NULL into bookings.status
 *  on purpose so D1 rolls a lost-race batch back; that only works while the
 *  column rejects NULL. If it ever did not, the worker must refuse to start
 *  rather than write a NULL status. PRAGMA cannot bind a parameter, so the
 *  names are validated against a strict pattern first. */
export async function assertNotNullColumn(db: D1Database, table: string, column: string): Promise<void> {
  if (!IDENTIFIER.test(table) || !IDENTIFIER.test(column)) {
    throw new Error("[booking] assertNotNullColumn: invalid table or column name");
  }
  const info = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string; notnull: number }>();
  const col = (info.results ?? []).find((r) => r.name === column);
  if (!col || Number(col.notnull) !== 1) {
    throw new Error(`[booking] ${table}.${column} must be NOT NULL (the deposit cancel guard depends on it)`);
  }
}
