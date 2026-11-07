import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuditRecorder } from "@repo/audit";
import { runSealer } from "../src/audit/sealer";
import { EXPIRY_ARCHIVE_OBJECTS, expireOldEntries } from "../src/audit/retention";

// Ruling 54: expiry's pre-delete re-verify (Ruling 40) gets the same
// archive-object bound as the nightly. A capped check has verified only a
// PREFIX of the candidates; expiry must delete only that prefix, never the
// unverified rest (deletion is irreversible). Own file (own D1): exact seqs.

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

describe("expireOldEntries archive-object budget (Ruling 54)", () => {
  it("has a bounded default", () => {
    expect(EXPIRY_ARCHIVE_OBJECTS).toBeGreaterThan(0);
    expect(EXPIRY_ARCHIVE_OBJECTS).toBeLessThanOrEqual(2000);
  });

  it("deletes only the verified prefix when the re-verify stops at the object budget", async () => {
    const old = new Date(Date.now() - 2200 * 24 * 3600 * 1000).toISOString();
    const rec = createAuditRecorder({ db: E.DB, worker: "t", via: "cron", actor: { type: "system" }, requestId: null });
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await rec.write({ action: "audit.verify", outcome: "succeeded", occurredAt: old, details: { i } });
      await runSealer(E, new Date(base + i * 1000)); // one seal batch = one archive object per row
    }
    for (let i = 0; i < 10; i++) {
      const r = await runSealer(E, new Date(base + (5 + i) * 1000));
      if (!r.sealed && !r.archived) break;
    }
    const keys = await E.DB.prepare("SELECT COUNT(DISTINCT archive_key) AS n FROM audit_log WHERE seq BETWEEN 1 AND 5 AND archived_at IS NOT NULL")
      .first<{ n: number }>();
    expect(keys!.n, "fixture must be 5 archived single-row objects").toBe(5);
    await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = 5 WHERE id = 1").run();

    const deleted = await expireOldEntries(E.DB, E.AUDIT_ARCHIVE, new Date(), 500, 2);
    expect(deleted).toBe(2);

    const remaining = await E.DB.prepare("SELECT seq FROM audit_log WHERE seq BETWEEN 1 AND 5 ORDER BY seq").all<{ seq: number }>();
    expect((remaining.results ?? []).map((r) => r.seq)).toEqual([3, 4, 5]);

    const entry = await E.DB.prepare(
      "SELECT outcome, details_json FROM audit_log WHERE action = 'audit.expire' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ outcome: string; details_json: string }>();
    expect(entry!.outcome).toBe("succeeded");
    expect(JSON.parse(entry!.details_json)).toMatchObject({ from_seq: 1, to_seq: 2, count: 2, verify_failed_at: null, verify_capped: true });

    const st = await E.DB.prepare("SELECT expired_through_seq FROM audit_seal_state WHERE id = 1").first<{ expired_through_seq: number }>();
    expect(st!.expired_through_seq).toBe(2);
  });
});
