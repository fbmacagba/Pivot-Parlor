/**
 * WS-8: the ensure-schema file is assert-only — it must pass on a database
 * built from the canonical migration chain, and fail loudly (naming the gap)
 * on one that missed a migration. If the booking worker ever needs a new
 * column, it goes in a canonical migration, and the REQUIRED list in
 * src/db/ensure-schema.ts is how drift gets caught at runtime.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { assertBookingSchema, assertNotNullColumn } from "../src/db/ensure-schema.js";
import "./apply-schema.js";

describe("assertBookingSchema", () => {
  it("passes on a database built from the canonical chain", async () => {
    await expect(assertBookingSchema(env.DB)).resolves.toBeUndefined();
  });

  it("names the missing column when a migration was skipped", async () => {
    // Simulate a database that never got migration 041's deposit column.
    await env.DB.prepare("ALTER TABLE shop_settings DROP COLUMN deposit_min_pence").run();
    await expect(assertBookingSchema(env.DB)).rejects.toThrow(/shop_settings\.deposit_min_pence/);
    // Restore for any test sharing this file's database.
    await env.DB.prepare(
      "ALTER TABLE shop_settings ADD COLUMN deposit_min_pence INTEGER NOT NULL DEFAULT 500"
    ).run();
  });

  it("names a missing table outright", async () => {
    await env.DB.prepare("ALTER TABLE bw_platform_alerts RENAME TO bw_platform_alerts_gone").run();
    await expect(assertBookingSchema(env.DB)).rejects.toThrow(/bw_platform_alerts \(table\)/);
    await env.DB.prepare("ALTER TABLE bw_platform_alerts_gone RENAME TO bw_platform_alerts").run();
  });
});

describe("assertNotNullColumn", () => {
  it("throws when the column allows NULL, passes when it is NOT NULL", async () => {
    await env.DB.prepare("CREATE TABLE t_nn_bad (status TEXT)").run();
    await env.DB.prepare("CREATE TABLE t_nn_ok (status TEXT NOT NULL)").run();
    try {
      await expect(assertNotNullColumn(env.DB, "t_nn_bad", "status")).rejects.toThrow(
        "[booking] t_nn_bad.status must be NOT NULL (the deposit cancel guard depends on it)"
      );
      await expect(assertNotNullColumn(env.DB, "t_nn_ok", "status")).resolves.toBeUndefined();
      await expect(assertNotNullColumn(env.DB, "t_nn_ok", "no_such_col")).rejects.toThrow(/must be NOT NULL/);
    } finally {
      await env.DB.prepare("DROP TABLE t_nn_bad").run();
      await env.DB.prepare("DROP TABLE t_nn_ok").run();
    }
  });

  it("the real bookings.status passes", async () => {
    await expect(assertNotNullColumn(env.DB, "bookings", "status")).resolves.toBeUndefined();
  });

  it("a malformed table name throws before any query", async () => {
    await expect(assertNotNullColumn(env.DB, "bookings; DROP TABLE bookings", "status")).rejects.toThrow(/invalid/i);
    await expect(assertNotNullColumn(env.DB, "bookings", "sta tus")).rejects.toThrow(/invalid/i);
    // The table is still there.
    await expect(assertBookingSchema(env.DB)).resolves.toBeUndefined();
  });
});
