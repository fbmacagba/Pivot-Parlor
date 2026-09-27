import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AuditWriteError, createAuditRecorder, entryHash, type AuditRow } from "@repo/audit";
import { seedShop, seedUser } from "./helpers";

const recorder = (userId: string | null, ip: string | null = "203.0.113.7", onWrite?: () => void) =>
  createAuditRecorder({
    db: env.DB as never,
    worker: "test",
    via: "api",
    actor: userId ? { type: "developer", userId, role: "developer", ip } : { type: "anonymous", ip },
    requestId: "req-1",
    onWrite,
  });

describe("audit recorder", () => {
  it("writes an entry whose hash matches, with subjects split out", async () => {
    const shopId = await seedShop("Rec Shop");
    const userId = await seedUser("developer", null);
    const id = await recorder(userId).write({
      action: "site.pause", outcome: "succeeded", shopId, entityType: "shop_site", entityId: shopId,
      changes: { website_status: ["live", "paused"], secret: ["x", "y"] },
    });
    const row = await env.DB.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<AuditRow>();
    expect(row!.entry_hash).toBe(await entryHash(row!));
    expect(row!.changes_json).toBe('{"website_status":["live","paused"]}');
    expect(row!.actor_ref).toBe(`subj_user_${userId}`);
    const subject = await env.DB.prepare("SELECT email, kind FROM audit_subjects WHERE id = ?").bind(row!.actor_ref).first<{ email: string; kind: string }>();
    expect(subject).toEqual({ email: `${userId}@test.local`, kind: "user" });
    const ip = await env.DB.prepare("SELECT ip, redact_after FROM audit_subjects WHERE id = ?").bind(row!.ip_ref).first<{ ip: string; redact_after: string }>();
    expect(ip!.ip).toBe("203.0.113.7");
    expect(Date.parse(ip!.redact_after) - Date.parse(row!.occurred_at)).toBe(30 * 24 * 3600 * 1000);
  });

  it("reuses one IP subject per day", async () => {
    const a = await recorder(null, "198.51.100.1").write({ action: "audit.gap", outcome: "succeeded" });
    const b = await recorder(null, "198.51.100.1").write({ action: "audit.gap", outcome: "succeeded" });
    const refs = await env.DB.prepare("SELECT DISTINCT ip_ref FROM audit_log WHERE id IN (?, ?)").bind(a, b).all<{ ip_ref: string | null }>();
    expect(refs.results).toHaveLength(1);
    expect(refs.results![0]!.ip_ref).not.toBeNull();
  });

  it("run() writes started and outcome rows, and a structured reason (never the message) on throw", async () => {
    const rec = recorder(null);
    class VendorError extends Error {
      status = 401;
      constructor() {
        super("vendor rejected key sk-live-do-not-store-this");
        this.name = "VendorError";
      }
    }
    await expect(rec.run({ action: "ai.call" }, async () => { throw new VendorError(); })).rejects.toThrow(
      "vendor rejected key sk-live-do-not-store-this"
    );
    const rows = await env.DB.prepare("SELECT phase, outcome, reason, parent_id, id FROM audit_log WHERE action = 'ai.call' ORDER BY occurred_at, phase DESC").all<{ phase: string; outcome: string | null; reason: string | null; parent_id: string | null; id: string }>();
    const started = rows.results!.find((r) => r.phase === "started")!;
    const outcome = rows.results!.find((r) => r.parent_id === started.id)!;
    expect(started.outcome).toBeNull();
    expect(outcome).toMatchObject({ phase: "outcome", outcome: "failed", reason: "VendorError (HTTP 401)" });
    expect(outcome.reason).not.toContain("sk-live");
  });

  it("stores a reason whose truncation boundary lands on a surrogate pair without splitting it, and hashes to match", async () => {
    const reason = "a".repeat(499) + "😀"; // 500 code points; naive UTF-16 .slice(0,500) would split the emoji
    const id = await recorder(null).write({ action: "audit.gap", outcome: "succeeded", reason });
    const row = await env.DB.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<AuditRow>();
    expect(row!.reason).toBe(reason);
    expect(row!.entry_hash).toBe(await entryHash(row!));
  });

  it("stores an entityId containing a lone surrogate as U+FFFD and hashes to match after the D1 round-trip", async () => {
    const id = await recorder(null).write({
      action: "audit.gap", outcome: "succeeded", entityType: "shop_site", entityId: "shop-\ud800-weird",
    });
    const row = await env.DB.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<AuditRow>();
    expect(row!.entity_id).toBe("shop-�-weird");
    expect(row!.entry_hash).toBe(await entryHash(row!));
  });

  it("run() refuses the action when the started entry cannot be written", async () => {
    await env.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_off").run();
    let ran = false;
    try {
      await expect(recorder(null).run({ action: "ai.call" }, async () => { ran = true; })).rejects.toBeInstanceOf(AuditWriteError);
      expect(ran).toBe(false);
    } finally {
      await env.DB.prepare("ALTER TABLE audit_log_off RENAME TO audit_log").run();
    }
  });

  it("rejects an unknown action", async () => {
    await expect(recorder(null).write({ action: "nope" as never, outcome: "succeeded" })).rejects.toBeInstanceOf(AuditWriteError);
  });

  it("statements() alone never triggers onWrite — a prepared-but-uncommitted entry is not a written one", async () => {
    let written = false;
    const stmts = await recorder(null, null, () => { written = true; }).statements({ action: "audit.gap", outcome: "succeeded" });
    expect(stmts.length).toBeGreaterThan(0);
    expect(written).toBe(false);
  });

  it("batch() triggers onWrite only once the combined batch has committed", async () => {
    let written = false;
    await recorder(null, null, () => { written = true; }).batch([], { action: "audit.gap", outcome: "succeeded" });
    expect(written).toBe(true);
  });

  it("batch() does not trigger onWrite when the batch fails, and propagates the original (unwrapped) error", async () => {
    let written = false;
    const badChange = env.DB.prepare("INSERT INTO no_such_table (id) VALUES (?)").bind("x");
    const rec = recorder(null, null, () => { written = true; });
    await expect(rec.batch([badChange as never], { action: "audit.gap", outcome: "succeeded" })).rejects.not.toBeInstanceOf(
      AuditWriteError
    );
    expect(written).toBe(false);
  });
});
