/**
 * Migration 052 against production's real reviews table.
 *
 * Production's reviews predates migration 009 (baselined there, never run).
 * Its shop_id carries only FOREIGN KEY (shop_id) REFERENCES shops(id), with no
 * ON DELETE CASCADE, so deleting a shop that has a review is refused. The
 * suite's setup already replayed the chain (so 052 ran on the chain's shape,
 * proving it replays); this test rebuilds production's exact definition, as
 * read from sqlite_master in the D1 console on 2026-11-10, seeds it, re-runs
 * the REAL 052 file, and checks the rows, the keys, the indexes and the delete.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import migration052 from "../src/db/migrations/052_reviews_canonical.sql?raw";
import { statements } from "../../../scripts/sql-statements.mjs";
import { seedShop, seedStaff } from "./helpers";

const PRODUCTION_DDL =
  "CREATE TABLE reviews ( id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, customer_name TEXT NOT NULL, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), booking_id TEXT REFERENCES bookings(id), FOREIGN KEY (shop_id) REFERENCES shops(id) )";
const PRODUCTION_INDEXES = [
  "CREATE INDEX idx_reviews_shop_id ON reviews(shop_id)",
  "CREATE UNIQUE INDEX idx_reviews_booking_id ON reviews(booking_id) WHERE booking_id IS NOT NULL",
];

async function seedBooking(shopId: string): Promise<string> {
  const staffId = await seedStaff(shopId);
  const serviceId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO services (id, shop_id, name) VALUES (?, ?, 'Cut')").bind(serviceId, shopId).run();
  const bookingId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email, booking_date, start_time, end_time, status)
     VALUES (?, ?, ?, ?, 'Cust', 'cust@test.local', '2026-11-01', '2026-11-01T10:00', '2026-11-01T10:30', 'completed')`
  )
    .bind(bookingId, shopId, staffId, serviceId)
    .run();
  return bookingId;
}

const deleteShop = (shopId: string) => env.DB.prepare("DELETE FROM shops WHERE id = ?").bind(shopId).run();

describe("migration 052 (reviews rebuilt to the chain's shape)", () => {
  it("lets a shop with reviews be deleted from production's table, keeping every review until then", async () => {
    const shopId = await seedShop("Reviewed Shop");
    const bookingId = await seedBooking(shopId);

    await env.DB.prepare("DROP TABLE reviews").run();
    await env.DB.prepare(PRODUCTION_DDL).run();
    for (const ddl of PRODUCTION_INDEXES) await env.DB.prepare(ddl).run();
    await env.DB.prepare(
      `INSERT INTO reviews (id, shop_id, customer_name, rating, body, created_at, booking_id)
       VALUES ('rev-booked', ?, 'Ada', 5, 'Great cut', '2026-11-02 09:00:00', ?),
              ('rev-legacy', ?, 'Bo', 4, 'Before booking ids', '2026-03-01 12:00:00', NULL)`
    )
      .bind(shopId, bookingId, shopId)
      .run();

    // Before: production refuses to delete the shop, and nothing is removed.
    await expect(deleteShop(shopId)).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    expect(await env.DB.prepare("SELECT id FROM shops WHERE id = ?").bind(shopId).first()).not.toBeNull();

    for (const stmt of statements(migration052)) await env.DB.prepare(stmt).run();

    const cols = await env.DB.prepare("PRAGMA table_info(reviews)").all<{
      name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }>();
    expect((cols.results ?? []).map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk])).toEqual([
      ["id", "TEXT", 0, "lower(hex(randomblob(16)))", 1],
      ["shop_id", "TEXT", 1, null, 0],
      ["customer_name", "TEXT", 1, null, 0],
      ["rating", "REAL", 1, null, 0],
      ["body", "TEXT", 1, null, 0],
      ["created_at", "TEXT", 1, "datetime('now')", 0],
      ["booking_id", "TEXT", 0, null, 0],
    ]);
    const fks = await env.DB.prepare("PRAGMA foreign_key_list(reviews)").all<{
      table: string; from: string; to: string; on_delete: string;
    }>();
    expect((fks.results ?? []).map((f) => [f.table, f.from, f.to, f.on_delete]).sort()).toEqual([
      ["bookings", "booking_id", "id", "NO ACTION"],
      ["shops", "shop_id", "id", "CASCADE"],
    ]);
    const ddl = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reviews'").first<{ sql: string }>();
    expect(ddl?.sql).not.toMatch(/CHECK/i);
    const indexes = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reviews' AND sql IS NOT NULL ORDER BY name"
    ).all<{ name: string; sql: string }>();
    expect(indexes.results).toEqual([
      { name: "idx_reviews_booking_id", sql: "CREATE UNIQUE INDEX idx_reviews_booking_id ON reviews(booking_id) WHERE booking_id IS NOT NULL" },
      { name: "idx_reviews_shop_created", sql: "CREATE INDEX idx_reviews_shop_created ON reviews(shop_id, created_at DESC)" },
    ]);
    expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'reviews_new'").first()).toBeNull();

    const rows = await env.DB.prepare(
      "SELECT id, shop_id, customer_name, rating, body, created_at, booking_id FROM reviews ORDER BY id"
    ).all();
    expect(rows.results).toEqual([
      { id: "rev-booked", shop_id: shopId, customer_name: "Ada", rating: 5, body: "Great cut", created_at: "2026-11-02 09:00:00", booking_id: bookingId },
      { id: "rev-legacy", shop_id: shopId, customer_name: "Bo", rating: 4, body: "Before booking ids", created_at: "2026-03-01 12:00:00", booking_id: null },
    ]);

    // One review per booking still holds.
    await expect(
      env.DB.prepare(
        "INSERT INTO reviews (id, shop_id, customer_name, rating, body, booking_id) VALUES ('rev-dup', ?, 'Ada', 1, 'Again', ?)"
      )
        .bind(shopId, bookingId)
        .run()
    ).rejects.toThrow(/UNIQUE constraint failed/i);

    // After: the shop goes, and its reviews go with it.
    await deleteShop(shopId);
    expect(await env.DB.prepare("SELECT id FROM shops WHERE id = ?").bind(shopId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE shop_id = ?").bind(shopId).first()).toEqual({ n: 0 });
  });
});
