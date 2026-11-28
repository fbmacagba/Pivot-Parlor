// Deleting a shop removes its payments, commission, sales and refunds. A copy
// of those records, without personal details, is written to the locked archive
// bucket first. If the copy cannot be written, the shop is not deleted.
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { runRetentionSweep } from "../src/services/retention";
import { expireArchiveFiles, SHOP_RECORD_TABLES, SHOP_RECORDS_PREFIX } from "../src/services/shop-archive";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff } from "./helpers";
import { devToken } from "./audit-helpers";

const PERSONAL = ["Jane Customer", "jane.customer@test.local", "07700900123", "Allergic to the blue dye", "Said it was faulty"];

async function seedMoney(shopId: string) {
  const bookingId = crypto.randomUUID();
  const serviceId = crypto.randomUUID();
  const saleId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const returnId = crypto.randomUUID();
  const db = env.DB;
  const staffId = await seedStaff(shopId);
  await db.batch([
    db
      .prepare("INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, is_active) VALUES (?, ?, 'Skin fade', 30, 2500, NULL, 1)")
      .bind(serviceId, shopId),
    db
      .prepare(
        `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email, customer_phone, notes,
           booking_date, start_time, end_time, status, amount_pence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-10-01', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 'completed', 2500)`,
      )
      .bind(bookingId, shopId, staffId, serviceId, PERSONAL[0], PERSONAL[1], PERSONAL[2], PERSONAL[3]),
    db
      .prepare(
        `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount_pence,
           deposit_application_fee_pence, deposit_paid_at, stripe_payment_intent_id, updated_at)
         VALUES (?, ?, 'online', 1250, 125, datetime('now'), 'pi_archive_dep', datetime('now'))`,
      )
      .bind(bookingId, shopId),
    db
      .prepare(
        `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
         VALUES (?, ?, ?, 'deposit', 1250, 'captured', 'pi_archive_dep')`,
      )
      .bind(crypto.randomUUID(), bookingId, shopId),
    db
      .prepare(
        `INSERT INTO sales (id, shop_id, customer_name, customer_email, subtotal_pence, total_pence, tender_type, status, note)
         VALUES (?, ?, ?, ?, 1200, 1200, 'cash', 'completed', ?)`,
      )
      .bind(saleId, shopId, PERSONAL[0], PERSONAL[1], PERSONAL[3]),
    db
      .prepare(
        `INSERT INTO sale_items (id, sale_id, shop_id, item_type, service_id, name, quantity, unit_price_pence, line_total_pence)
         VALUES (?, ?, ?, 'service', ?, 'Skin fade', 1, 1200, 1200)`,
      )
      .bind(itemId, saleId, shopId, serviceId),
    db
      .prepare(
        `INSERT INTO sale_returns (id, shop_id, sale_id, refund_pence, tender_type, status, reason, created_by)
         VALUES (?, ?, ?, 1200, 'cash', 'completed', ?, 'user-x')`,
      )
      .bind(returnId, shopId, saleId, PERSONAL[4]),
    db
      .prepare(
        `INSERT INTO refund_requests (id, shop_id, kind, sale_id, amount_pence, reason, evidence_name, status, requested_by, requested_at)
         VALUES (?, ?, 'sale', ?, 1200, ?, 'receipt of Jane Customer.png', 'approved', 'user-x', datetime('now'))`,
      )
      .bind(crypto.randomUUID(), shopId, saleId, PERSONAL[4]),
  ]);
  return { bookingId, saleId, returnId };
}

async function filesUnder(prefix: string): Promise<string[]> {
  return (await env.AUDIT_ARCHIVE.list({ prefix })).objects.map((o) => o.key);
}

async function read(key: string): Promise<string> {
  return (await (await env.AUDIT_ARCHIVE.get(key))!.text());
}

async function deleteShop(shopId: string) {
  const { token } = await devToken();
  return dispatch("DELETE", `/api/shops/${shopId}`, { headers: authHeaders(token) });
}

describe("deleting a shop archives its money records", () => {
  it("writes the payments, sales and refunds to the archive, then deletes the shop", async () => {
    const shopId = await seedShop("Archive Shop");
    const { bookingId, saleId, returnId } = await seedMoney(shopId);

    expect((await deleteShop(shopId)).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 AS n FROM shops WHERE id = ?").bind(shopId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS n FROM sales WHERE id = ?").bind(saleId).first()).toBeNull();

    const keys = await filesUnder(`${SHOP_RECORDS_PREFIX}${shopId}/`);
    const manifestKey = keys.find((k) => k.endsWith("/manifest.json"))!;
    expect(manifestKey, keys.join(", ")).toBeTruthy();
    const manifest = JSON.parse(await read(manifestKey)) as {
      shop_id: string;
      rows: Record<string, number>;
      absent: string[];
    };
    expect(manifest.shop_id).toBe(shopId);
    // Every listed table is either counted or written down as not in this database.
    expect([...Object.keys(manifest.rows), ...manifest.absent.filter((a) => !a.includes("."))].sort()).toEqual(
      SHOP_RECORD_TABLES.map((t) => t.table).sort(),
    );
    // The money tables themselves are all here, with every listed column.
    for (const table of ["bw_transactions", "bw_commission_ledger", "sales", "sale_items", "sale_returns", "refund_requests"]) {
      expect(manifest.absent.filter((a) => a === table || a.startsWith(`${table}.`)), table).toEqual([]);
    }
    expect(manifest.rows).toMatchObject({
      bookings: 1,
      bw_booking_state: 1,
      bw_transactions: 1,
      sales: 1,
      sale_items: 1,
      sale_returns: 1,
      refund_requests: 1,
    });

    const part = (table: string) =>
      read(keys.find((k) => k.endsWith(`/${table}-0001.json`))!).then(
        (t) => JSON.parse(t) as { rows: Array<Record<string, unknown>> },
      );
    expect((await part("bw_transactions")).rows[0]).toMatchObject({
      booking_id: bookingId,
      type: "deposit",
      amount_pence: 1250,
      stripe_id: "pi_archive_dep",
    });
    expect((await part("sales")).rows[0]).toMatchObject({ id: saleId, total_pence: 1200, tender_type: "cash" });
    expect((await part("sale_returns")).rows[0]).toMatchObject({ id: returnId, refund_pence: 1200 });
  });

  it("keeps every personal detail out of the archive, which cannot be erased", async () => {
    const shopId = await seedShop("Archive Privacy Shop");
    await seedMoney(shopId);
    expect((await deleteShop(shopId)).status).toBe(200);

    const keys = await filesUnder(`${SHOP_RECORDS_PREFIX}${shopId}/`);
    expect(keys.length).toBeGreaterThan(3);
    const all = (await Promise.all(keys.map(read))).join("\n");
    for (const value of [...PERSONAL, "Archive Privacy Shop", "receipt of"]) expect(all, value).not.toContain(value);
    for (const { columns } of SHOP_RECORD_TABLES) {
      for (const column of columns) {
        // `name` on an item is the service or product sold, not a person.
        expect(column).not.toMatch(/customer|display_name|email|phone|note|reason|evidence|qr_code|summary|performance/);
      }
    }
  });

  it("does not delete the shop when the archive cannot be written", async () => {
    const shopId = await seedShop("Archive Refused Shop");
    const { saleId } = await seedMoney(shopId);
    const put = vi.spyOn(env.AUDIT_ARCHIVE, "put").mockRejectedValue(new Error("bucket unavailable"));
    try {
      expect((await deleteShop(shopId)).status).toBeGreaterThanOrEqual(500);
    } finally {
      put.mockRestore();
    }
    expect(await env.DB.prepare("SELECT 1 AS n FROM shops WHERE id = ?").bind(shopId).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS n FROM sales WHERE id = ?").bind(saleId).first()).not.toBeNull();
  });
});

describe("archive files leave once their lock has ended", () => {
  it("removes only files older than the given age, and no more than the limit", async () => {
    const prefix = `${SHOP_RECORDS_PREFIX}age-test-${crypto.randomUUID()}/`;
    await env.AUDIT_ARCHIVE.put(`${prefix}a.json`, "{}");
    await env.AUDIT_ARCHIVE.put(`${prefix}b.json`, "{}");
    const later = (days: number) => new Date(Date.now() + days * 86_400_000);

    expect(await expireArchiveFiles(env.AUDIT_ARCHIVE, prefix, 2193, 500, later(2192))).toBe(0);
    expect(await filesUnder(prefix)).toHaveLength(2);
    expect(await expireArchiveFiles(env.AUDIT_ARCHIVE, prefix, 2193, 1, later(2194))).toBe(1);
    expect(await filesUnder(prefix)).toHaveLength(1);
    expect(await expireArchiveFiles(env.AUDIT_ARCHIVE, prefix, 2193, 500, later(2194))).toBe(1);
    expect(await filesUnder(prefix)).toHaveLength(0);
  });

  it("the nightly sweep runs both file sweeps and leaves young files alone", async () => {
    const key = `${SHOP_RECORDS_PREFIX}young-${crypto.randomUUID()}/manifest.json`;
    await env.AUDIT_ARCHIVE.put(key, "{}");
    const { counts, errors } = await runRetentionSweep(env.DB, env.AUDIT_ARCHIVE);
    expect(errors).toEqual([]);
    expect(counts.shop_records_expired).toBe(0);
    expect(counts.refund_evidence_files_expired).toBe(0);
    expect(await env.AUDIT_ARCHIVE.head(key)).not.toBeNull();
  });
});
