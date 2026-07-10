/**
 * WS-4: prove the pounds->pence conversion migrations do what they claim,
 * using the REAL migration file (027) against a real old-shape table with
 * real float-pounds data — not a copy of its SQL.
 *
 * The suite's apply-schema setup already replayed the chain, so
 * bw_transactions is at its final (pence) shape here. This test reverts it to
 * the pre-WS-4 shape, seeds pounds values (including binary-float dirt),
 * re-runs 027, and asserts exact integer pence. It then asserts the
 * replay-guard reports "skip" once the old column is gone — the mechanism
 * that keeps the chain replayable on databases built from the snapshot.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import migration027 from "../src/db/migrations/027_pence_bw_transactions.sql?raw";
import { seedShop } from "./helpers";

// Mirrors scripts/migrate.mjs and apply-schema.ts.
const GUARD_RE = /^--\s*replay-guard:\s*skip-if-column-absent\s+([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*$/m;

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function guardSaysSkip(sql: string): Promise<boolean> {
  const m = sql.match(GUARD_RE);
  if (!m) return false;
  const info = await env.DB.prepare(`PRAGMA table_info(${m[1]})`).all<{ name: string }>();
  return !(info.results ?? []).some((row) => row.name === m[2]);
}

describe("WS-4 pence conversion (migration 027 against an old-shape bw_transactions)", () => {
  it("declares a replay-guard on the column it drops", () => {
    const m = migration027.match(GUARD_RE);
    expect(m?.[1]).toBe("bw_transactions");
    expect(m?.[2]).toBe("amount");
  });

  it("converts float pounds to exact integer pence, drops the old column, then guard-skips", async () => {
    const shop = await seedShop("Pence Shop");

    // Revert bw_transactions to its pre-WS-4 shape (pounds REAL).
    await env.DB.prepare("ALTER TABLE bw_transactions DROP COLUMN amount_pence").run();
    await env.DB.prepare("ALTER TABLE bw_transactions ADD COLUMN amount REAL NOT NULL DEFAULT 0").run();
    expect(await guardSaysSkip(migration027)).toBe(false);

    // Pounds values as production stored them, including 0.1 + 0.2 float dirt.
    const seed: Array<[string, number]> = [
      ["tx-a", 12.5],
      ["tx-b", 9.99],
      ["tx-c", 0.1 + 0.2],
      ["tx-d", 100],
    ];
    for (const [id, pounds] of seed) {
      await env.DB.prepare(
        `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount, status, stripe_id)
         VALUES (?, NULL, ?, 'deposit', ?, 'pending', NULL)`
      )
        .bind(id, shop, pounds)
        .run();
    }

    // Run the real migration file exactly as the appliers would.
    for (const stmt of statements(migration027)) {
      await env.DB.prepare(stmt).run();
    }

    const rows = await env.DB
      .prepare("SELECT id, amount_pence FROM bw_transactions WHERE shop_id = ? ORDER BY id")
      .bind(shop)
      .all<{ id: string; amount_pence: number }>();
    expect(rows.results).toEqual([
      { id: "tx-a", amount_pence: 1250 },
      { id: "tx-b", amount_pence: 999 },
      { id: "tx-c", amount_pence: 30 },
      { id: "tx-d", amount_pence: 10000 },
    ]);

    // The old pounds column is gone and the guard now reports skip — a
    // replayed chain will record 027 without executing it.
    const info = await env.DB.prepare("PRAGMA table_info(bw_transactions)").all<{ name: string }>();
    const cols = (info.results ?? []).map((r) => r.name);
    expect(cols).not.toContain("amount");
    expect(cols).toContain("amount_pence");
    expect(await guardSaysSkip(migration027)).toBe(true);

    // Integer SUM is exact — the WS-4 acceptance criterion.
    const sum = await env.DB
      .prepare("SELECT SUM(amount_pence) AS s FROM bw_transactions WHERE shop_id = ?")
      .bind(shop)
      .first<{ s: number }>();
    expect(sum?.s).toBe(1250 + 999 + 30 + 10000);
  });
});
