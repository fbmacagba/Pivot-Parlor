import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AuditWriteError, createAuditRecorder, entryHash, type AuditRow } from "@repo/audit";
import { seedShop, seedUser } from "./helpers";

const recorder = (userId: string | null, ip: string | null = "203.0.113.7") =>
  createAuditRecorder({
    db: env.DB as never,
    worker: "test",
    via: "api",
    actor: userId ? { type: "developer", userId, role: "developer", ip } : { type: "anonymous", ip },
    requestId: "req-1",
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
    const refs = await env.DB.prepare("SELECT DISTINCT ip_ref FROM audit_log WHERE id IN (?, ?)").bind(a, b).all();
    expect(refs.results).toHaveLength(1);
  });

  it("run() writes started and outcome rows, and failed on throw", async () => {
    const rec = recorder(null);
    await expect(rec.run({ action: "ai.call" }, async () => { throw new Error("vendor 401"); })).rejects.toThrow("vendor 401");
    const rows = await env.DB.prepare("SELECT phase, outcome, reason, parent_id, id FROM audit_log WHERE action = 'ai.call' ORDER BY occurred_at, phase DESC").all<{ phase: string; outcome: string | null; reason: string | null; parent_id: string | null; id: string }>();
    const started = rows.results!.find((r) => r.phase === "started")!;
    const outcome = rows.results!.find((r) => r.parent_id === started.id)!;
    expect(started.outcome).toBeNull();
    expect(outcome).toMatchObject({ phase: "outcome", outcome: "failed", reason: "vendor 401" });
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
});
