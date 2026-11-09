/**
 * Migration 051 against production's real ai_usage_log.
 *
 * Production's table predates migration 019 (baselined there, never run) and
 * carries CHECK(usage_type IN ('research','image','chatbot','site_build')),
 * which refuses every site-pipeline cost row. The suite's setup already
 * replayed the chain (so 051 ran on the chain's shape, proving it replays);
 * this test rebuilds production's exact definition, as read from
 * sqlite_master in the D1 console on 2026-11-09, seeds it, re-runs the REAL
 * 051 file, and checks the rows, the key and the insert the workers make.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { recordAiUsage } from "@repo/llm";
import migration051 from "../src/db/migrations/051_ai_usage_log_canonical.sql?raw";
import { statements } from "../../../scripts/sql-statements.mjs";
import { seedShop } from "./helpers";

const PRODUCTION_DDL =
  "CREATE TABLE ai_usage_log ( id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL, worker_name TEXT NOT NULL, model TEXT NOT NULL, usage_type TEXT NOT NULL CHECK(usage_type IN ('research','image','chatbot','site_build')), input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0, job_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')) , cost_basis TEXT)";

const CANONICAL_COLUMNS = [
  "id", "shop_id", "worker_name", "model", "usage_type", "input_tokens", "output_tokens",
  "total_tokens", "estimated_cost_usd", "job_id", "created_at", "cost_basis",
];

const kv = { get: async () => null };

async function recordImage(shopId: string, log: (m: string) => void) {
  return recordAiUsage(
    { DB: env.DB as never, KV: kv },
    {
      shopId,
      workerName: "pivot-parlor-images",
      modelId: "google/gemini-3.1-flash-image",
      usageType: "site_image_hero",
      usage: { inputTokens: 29, outputTokens: 1120 },
      jobId: "job-051",
      pricing: { from: "reported", usd: 0.0672 },
    },
    log
  );
}

describe("migration 051 (ai_usage_log rebuilt to the chain's shape)", () => {
  it("lets the site pipeline's cost rows into production's table, keeping every old row", async () => {
    const shopId = await seedShop("Cost Log Shop");
    await env.DB.prepare("DROP TABLE ai_usage_log").run();
    await env.DB.prepare(PRODUCTION_DDL).run();
    await env.DB.prepare(
      `INSERT INTO ai_usage_log (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, job_id, created_at)
       VALUES ('old-chat', ?, 'pivot-parlor-chatbot', 'm', 'chatbot', 10, 5, 15, 0.001, 'public-chat:x', '2026-03-24 21:40:44'),
              ('old-research', NULL, 'pivot-parlor-research', 'm', 'research', 1, 2, 3, 0.002, NULL, '2026-04-01 00:00:00')`
    )
      .bind(shopId)
      .run();

    // Before: production refuses the row, and the failure line names why.
    const before: string[] = [];
    expect(await recordImage(shopId, (m) => before.push(m))).toBeNull();
    expect(before.join("\n")).toMatch(/CHECK constraint failed/i);

    for (const stmt of statements(migration051)) await env.DB.prepare(stmt).run();

    const ddl = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_usage_log'").first<{ sql: string }>();
    expect(ddl?.sql).not.toMatch(/CHECK/i);
    const cols = await env.DB.prepare("PRAGMA table_info(ai_usage_log)").all<{ name: string }>();
    expect((cols.results ?? []).map((c) => c.name)).toEqual(CANONICAL_COLUMNS);
    const fks = await env.DB.prepare("PRAGMA foreign_key_list(ai_usage_log)").all<{ table: string; from: string; to: string; on_delete: string }>();
    expect((fks.results ?? []).map((f) => [f.table, f.from, f.to, f.on_delete])).toEqual([["shops", "shop_id", "id", "SET NULL"]]);
    expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'ai_usage_log_new'").first()).toBeNull();

    const rows = await env.DB.prepare(
      "SELECT id, shop_id, worker_name, usage_type, total_tokens, estimated_cost_usd, job_id, created_at FROM ai_usage_log ORDER BY id"
    ).all();
    expect(rows.results).toEqual([
      { id: "old-chat", shop_id: shopId, worker_name: "pivot-parlor-chatbot", usage_type: "chatbot", total_tokens: 15, estimated_cost_usd: 0.001, job_id: "public-chat:x", created_at: "2026-03-24 21:40:44" },
      { id: "old-research", shop_id: null, worker_name: "pivot-parlor-research", usage_type: "research", total_tokens: 3, estimated_cost_usd: 0.002, job_id: null, created_at: "2026-04-01 00:00:00" },
    ]);

    // After: the same call the images worker makes is recorded, with its cost.
    const after: string[] = [];
    expect(await recordImage(shopId, (m) => after.push(m))).toEqual({ costUsd: 0.0672, basis: "reported" });
    expect(after).toEqual([]);
    const written = await env.DB.prepare(
      "SELECT usage_type, estimated_cost_usd, cost_basis, job_id FROM ai_usage_log WHERE job_id = 'job-051'"
    ).first();
    expect(written).toEqual({ usage_type: "site_image_hero", estimated_cost_usd: 0.0672, cost_basis: "reported", job_id: "job-051" });
  });
});
