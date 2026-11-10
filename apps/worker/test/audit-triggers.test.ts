import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const insertRow = (id: string, occurredAt: string) =>
  env.DB.prepare(
    `INSERT INTO audit_log (id, occurred_at, entry_hash, actor_type, via, action, phase, outcome, worker, historical)
     VALUES (?, ?, 'h', 'system', 'cron', 'audit.verify', 'done', 'succeeded', 'test', 0)`
  ).bind(id, occurredAt).run();

const SEVEN_YEARS_AGO = () => new Date(Date.now() - 7 * 365 * 24 * 3600 * 1000).toISOString();

/** What the sealer does: seq, sealed_at and chain_hash, once, by UPDATE. */
const seal = (id: string, seq: number) =>
  env.DB.prepare("UPDATE audit_log SET seq = ?, sealed_at = 'now', chain_hash = 'c' WHERE id = ?").bind(seq, id).run();

/** What the nightly archive step does: archived_at and archive_key, once. */
const archive = (id: string) =>
  env.DB.prepare("UPDATE audit_log SET archived_at = 'now', archive_key = 'k' WHERE id = ?").bind(id).run();

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

  it("rejects deleting a young row and allows deleting a 7-year-old archived one", async () => {
    await insertRow("t-young", new Date().toISOString());
    await expect(env.DB.prepare("DELETE FROM audit_log WHERE id = 't-young'").run()).rejects.toThrow(/append-only/);
    await insertRow("t-old", SEVEN_YEARS_AGO());
    await seal("t-old", 301);
    await archive("t-old");
    await env.DB.prepare("DELETE FROM audit_log WHERE id = 't-old'").run();
    const gone = await env.DB.prepare("SELECT id FROM audit_log WHERE id = 't-old'").first();
    expect(gone).toBeNull();
  });

  // occurred_at is supplied by the writer, so an old time alone proves
  // nothing: a row nobody has sealed and archived yet is in no hash chain and
  // no R2 archive, and removing it would leave no trace.
  it("rejects deleting an unsealed row, however old its time", async () => {
    await insertRow("t-backdated", SEVEN_YEARS_AGO());
    await expect(env.DB.prepare("DELETE FROM audit_log WHERE id = 't-backdated'").run()).rejects.toThrow(/append-only/);
    expect(await env.DB.prepare("SELECT id FROM audit_log WHERE id = 't-backdated'").first()).not.toBeNull();
  });

  it("rejects deleting a sealed row that is not archived yet, however old its time", async () => {
    await insertRow("t-unarchived", SEVEN_YEARS_AGO());
    await seal("t-unarchived", 302);
    await expect(env.DB.prepare("DELETE FROM audit_log WHERE id = 't-unarchived'").run()).rejects.toThrow(/append-only/);
    expect(await env.DB.prepare("SELECT id FROM audit_log WHERE id = 't-unarchived'").first()).not.toBeNull();
  });

  // SQLite's REPLACE removes the conflicting row without firing DELETE
  // triggers and never fires UPDATE triggers, so without an insert guard it
  // could swap an unsealed entry for new content with a matching entry_hash.
  it("rejects INSERT OR REPLACE over an existing entry and leaves it unchanged", async () => {
    await insertRow("t-replace", new Date().toISOString());
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO audit_log (id, occurred_at, entry_hash, actor_type, via, action, phase, outcome, worker, historical, reason)
         VALUES ('t-replace', ?, 'forged', 'system', 'cron', 'audit.verify', 'done', 'succeeded', 'test', 0, 'forged')`
      ).bind(new Date().toISOString()).run()
    ).rejects.toThrow(/append-only/);
    const row = await env.DB.prepare("SELECT entry_hash, reason FROM audit_log WHERE id = 't-replace'").first();
    expect(row).toEqual({ entry_hash: "h", reason: null });
  });

  // Only the sealer sets these, and only by UPDATE (audit_log_seal_only).
  it.each([
    ["seq", 7],
    ["sealed_at", "2026-11-10T00:00:00.000Z"],
    ["chain_hash", "c"],
    ["archived_at", "2026-11-10T00:00:00.000Z"],
    ["archive_key", "k"],
  ])("rejects an entry that arrives with %s already set", async (column, value) => {
    const id = `t-pre-${column}`;
    await expect(
      env.DB.prepare(
        `INSERT INTO audit_log (id, occurred_at, entry_hash, actor_type, via, action, phase, outcome, worker, historical, ${column})
         VALUES (?, ?, 'h', 'system', 'cron', 'audit.verify', 'done', 'succeeded', 'test', 0, ?)`
      ).bind(id, new Date().toISOString(), value).run()
    ).rejects.toThrow(/append-only/);
    expect(await env.DB.prepare("SELECT id FROM audit_log WHERE id = ?").bind(id).first()).toBeNull();
  });

  // A TEXT PRIMARY KEY accepts NULL in SQLite; an entry with no id could
  // never be referenced as a parent or found again.
  it("rejects an entry without an id", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO audit_log (id, occurred_at, entry_hash, actor_type, via, action, phase, outcome, worker, historical)
         VALUES (NULL, ?, 'h-null-id', 'system', 'cron', 'audit.verify', 'done', 'succeeded', 'test', 0)`
      ).bind(new Date().toISOString()).run()
    ).rejects.toThrow(/append-only/);
    expect(await env.DB.prepare("SELECT id FROM audit_log WHERE entry_hash = 'h-null-id'").first()).toBeNull();
  });
});
