/**
 * A deleted shop's money records, kept as files.
 *
 * Deleting a shop removes every row it owns (the tables cascade), including
 * its payments, commission, sales and refunds. Those are financial records
 * the platform must be able to produce for about 6 years, so before the rows
 * go they are written to the private archive bucket (AUDIT_ARCHIVE), under
 * shop-records/<shop id>/<time>/.
 *
 * The bucket is locked: a file cannot be changed or deleted for 2192 days.
 * That is the retention, and it is also why nothing personal may be written
 * here: it could not be erased on request. Only the columns named below are
 * copied. Customer names, email addresses, phone numbers, notes, refund
 * reasons and evidence file names are left out, and so are the shop's name
 * and slug (a sole trader's own name). What remains is ids, dates, amounts,
 * statuses and the payment provider's references.
 *
 * The nightly retention sweep removes the files once the lock has ended
 * (expireArchiveFiles).
 */
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export const SHOP_RECORDS_PREFIX = "shop-records/";

/** Rows per file, and per read. */
const PAGE = 1000;

/** Each archived table and the columns copied from it. Every table has shop_id. */
export const SHOP_RECORD_TABLES: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
  {
    table: "bookings",
    columns: [
      "id", "staff_id", "service_id", "booking_date", "start_time", "end_time", "status",
      "amount_pence", "commission_pence", "created_at",
    ],
  },
  {
    table: "bw_booking_state",
    columns: [
      "booking_id", "booking_type", "deposit_amount_pence", "total_amount_pence", "stripe_payment_intent_id",
      "stripe_balance_pi", "stripe_checkout_session_id", "promo_code", "promo_discount_percent",
      "deposit_paid_at", "deposit_application_fee_pence", "completed_at", "updated_at",
    ],
  },
  {
    table: "bw_booking_items",
    columns: [
      "id", "booking_id", "item_type", "service_id", "name", "quantity", "unit_price_pence",
      "total_price_pence", "is_commissionable", "created_at",
    ],
  },
  {
    table: "bw_transactions",
    columns: ["id", "booking_id", "sale_id", "type", "amount_pence", "status", "stripe_id", "created_at"],
  },
  {
    table: "bw_commission_ledger",
    columns: [
      "id", "business_day_id", "booking_id", "sale_id", "services_amount_pence", "commission_rate",
      "commission_amount_pence", "commission_bearer", "retail_amount_pence", "retail_commission_rate",
      "stripe_transfer_id", "status", "created_at",
    ],
  },
  { table: "bw_business_days", columns: ["id", "date", "status", "opened_at", "closed_at"] },
  {
    table: "sales",
    columns: [
      "id", "booking_id", "business_day_id", "staff_id", "subtotal_pence", "discount_pence", "tax_pence",
      "tip_pence", "total_pence", "refunded_pence", "tender_type", "stripe_payment_intent_id",
      "stripe_checkout_session_id", "status", "created_at", "completed_at",
    ],
  },
  {
    table: "sale_items",
    columns: [
      "id", "sale_id", "item_type", "service_id", "product_id", "variant_id", "name", "quantity",
      "unit_price_pence", "cost_price_pence", "tax_pence", "line_total_pence", "returned_quantity",
      "staff_id", "is_commissionable", "created_at",
    ],
  },
  {
    table: "sale_returns",
    columns: [
      "id", "sale_id", "refund_pence", "commission_reversal_pence", "tender_type", "status",
      "stripe_refund_id", "created_by", "created_at", "completed_at",
    ],
  },
  { table: "sale_return_items", columns: ["id", "return_id", "sale_item_id", "quantity", "refund_pence", "restocked"] },
  {
    table: "refund_requests",
    columns: [
      "id", "kind", "booking_id", "sale_id", "lines_json", "amount_pence", "refunded_pence", "status",
      "shop_cancelled", "requested_by", "requested_at", "reviewed_by", "reviewed_at",
    ],
  },
];

export type ShopArchiveResult = {
  /** Folder the files were written under, ending in "/". */
  prefix: string;
  /** Rows written per table. */
  rows: Record<string, number>;
  /** Listed tables and columns this database does not have (older or newer schema). */
  absent: string[];
};

/**
 * Write a shop's money records to the archive bucket. Throws if any read or
 * write fails: the caller must not delete the shop then. `manifest.json` is
 * written last, so a folder without one is an archive that did not finish.
 */
export async function archiveShopRecords(
  db: D1Database,
  bucket: R2Bucket,
  shop: { id: string; type?: string | null; created_at?: string | null },
  now: Date = new Date(),
): Promise<ShopArchiveResult> {
  // A new folder every time: a locked file cannot be overwritten, so a second
  // attempt (after a delete that failed part-way) must not reuse the first's.
  const stamp = `${now.toISOString().replace(/[-:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
  const prefix = `${SHOP_RECORDS_PREFIX}${shop.id}/${stamp}/`;
  const rows: Record<string, number> = {};
  const absent: string[] = [];
  const json = { httpMetadata: { contentType: "application/json" } };

  for (const { table, columns: wanted } of SHOP_RECORD_TABLES) {
    // Copy what this database has. A table or column the list names but the
    // database lacks is written down in the manifest, never a failed delete:
    // a shop that could not be deleted over a retired column helps nobody.
    const info = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const present = new Set(info.results.map((c) => c.name));
    if (!present.has("shop_id")) {
      absent.push(table);
      continue;
    }
    const columns = wanted.filter((c) => present.has(c));
    absent.push(...wanted.filter((c) => !present.has(c)).map((c) => `${table}.${c}`));
    let count = 0;
    for (let part = 1; ; part++) {
      const { results } = await db
        .prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE shop_id = ? ORDER BY rowid LIMIT ? OFFSET ?`)
        .bind(shop.id, PAGE, count)
        .all<Record<string, unknown>>();
      if (!results.length) break;
      await bucket.put(
        `${prefix}${table}-${String(part).padStart(4, "0")}.json`,
        JSON.stringify({ table, shop_id: shop.id, part, columns, rows: results }),
        json,
      );
      count += results.length;
      if (results.length < PAGE) break;
    }
    rows[table] = count;
  }

  await bucket.put(
    `${prefix}manifest.json`,
    JSON.stringify({
      shop_id: shop.id,
      shop_type: shop.type ?? null,
      shop_created_at: shop.created_at ?? null,
      archived_at: now.toISOString(),
      rows,
      absent,
    }),
    json,
  );
  return { prefix, rows, absent };
}

/**
 * Delete files under `prefix` that were stored more than `olderThanDays` ago.
 * Looks at no more than `maxListed` files a run and deletes no more than
 * `maxDeleted`, so one night's work is bounded. Returns how many it deleted.
 */
export async function expireArchiveFiles(
  bucket: R2Bucket,
  prefix: string,
  olderThanDays: number,
  maxDeleted: number,
  now: Date = new Date(),
  maxListed = 20_000,
): Promise<number> {
  const cutoff = now.getTime() - olderThanDays * 86_400_000;
  let listed = 0;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    listed += page.objects.length;
    const due = page.objects
      .filter((o) => o.uploaded.getTime() < cutoff)
      .map((o) => o.key)
      .slice(0, maxDeleted - deleted);
    if (due.length) await bucket.delete(due);
    deleted += due.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && deleted < maxDeleted && listed < maxListed);
  return deleted;
}
