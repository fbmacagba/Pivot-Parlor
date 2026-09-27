import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const insertRow = (id: string, occurredAt: string) =>
  env.DB.prepare(
    `INSERT INTO audit_log (id, occurred_at, entry_hash, actor_type, via, action, phase, outcome, worker, historical)
     VALUES (?, ?, 'h', 'system', 'cron', 'audit.verify', 'done', 'succeeded', 'test', 0)`
  ).bind(id, occurredAt).run();

describe("audit_log protection", () => {
  it("has the seal-state row", async () => {
    const row = await env.DB.prepare("SELECT id FROM audit_seal_state WHERE id = 1").first();
    expect(row).not.toBeNull();
  });

  it("rejects editing a hashed column", async () => {
    await insertRow("t-edit", new Date().toISOString());
    await expect(
      env.DB.prepare("UPDATE audit_log SET reason = 'x' WHERE id = 't-edit'").run()
    ).rejects.toThrow(/append-only/);
  });

  it("allows sealing columns exactly once", async () => {
    await insertRow("t-seal", new Date().toISOString());
    await env.DB.prepare(
      "UPDATE audit_log SET seq = 1, sealed_at = 'now', chain_hash = 'c' WHERE id = 't-seal'"
    ).run();
    await env.DB.prepare(
      "UPDATE audit_log SET archived_at = 'now', archive_key = 'k' WHERE id = 't-seal'"
    ).run();
    await expect(
      env.DB.prepare("UPDATE audit_log SET chain_hash = 'other' WHERE id = 't-seal'").run()
    ).rejects.toThrow(/append-only/);
  });

  it("rejects deleting a young row and allows deleting a 7-year-old one", async () => {
    await insertRow("t-young", new Date().toISOString());
    await expect(env.DB.prepare("DELETE FROM audit_log WHERE id = 't-young'").run()).rejects.toThrow(/append-only/);
    const old = new Date(Date.now() - 7 * 365 * 24 * 3600 * 1000).toISOString();
    await insertRow("t-old", old);
    await env.DB.prepare("DELETE FROM audit_log WHERE id = 't-old'").run();
    const gone = await env.DB.prepare("SELECT id FROM audit_log WHERE id = 't-old'").first();
    expect(gone).toBeNull();
  });
});
