import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuditRecorder } from "@repo/audit";
import { runSealer } from "../src/audit/sealer";
import { expireOldEntries } from "../src/audit/retention";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

// Own file (own vitest-pool-workers D1): Ruling 40 needs a small, entirely
// old, entirely archived, entirely verified multi-row prefix under its own
// control, distinct from audit-retention-expiry.test.ts's single-old-row
// scenario (that file is about the last_verified_seq gate itself, Ruling 38;
// this one is about the pre-delete re-verification, Ruling 40).

async function dropTriggers() {
  await E.DB.prepare("DROP TRIGGER IF EXISTS audit_log_seal_only").run();
}

// Migration 046's own DDL, verbatim (apps/worker/src/db/migrations/046_audit_trail.sql).
// Restoring it (rather than leaving it dropped for the rest of the file)
// keeps every OTHER row here protected by the normal append-only guard --
// only the one row deliberately forged below is ever mutated outside it.
async function restoreTriggers() {
  await E.DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS audit_log_seal_only
     BEFORE UPDATE ON audit_log
     WHEN NOT (
       OLD.id IS NEW.id AND OLD.occurred_at IS NEW.occurred_at AND OLD.entry_hash IS NEW.entry_hash
       AND OLD.actor_type IS NEW.actor_type AND OLD.actor_ref IS NEW.actor_ref AND OLD.actor_role IS NEW.actor_role
       AND OLD.via IS NEW.via AND OLD.action IS NEW.action AND OLD.phase IS NEW.phase
       AND OLD.outcome IS NEW.outcome AND OLD.reason IS NEW.reason AND OLD.shop_id IS NEW.shop_id
       AND OLD.entity_type IS NEW.entity_type AND OLD.entity_id IS NEW.entity_id
       AND OLD.changes_json IS NEW.changes_json AND OLD.details_json IS NEW.details_json
       AND OLD.request_id IS NEW.request_id AND OLD.parent_id IS NEW.parent_id
       AND OLD.worker IS NEW.worker AND OLD.ip_ref IS NEW.ip_ref AND OLD.historical IS NEW.historical
       AND (OLD.seq IS NULL OR OLD.seq IS NEW.seq)
       AND (OLD.sealed_at IS NULL OR OLD.sealed_at IS NEW.sealed_at)
       AND (OLD.chain_hash IS NULL OR OLD.chain_hash IS NEW.chain_hash)
       AND (OLD.archived_at IS NULL OR OLD.archived_at IS NEW.archived_at)
       AND (OLD.archive_key IS NULL OR OLD.archive_key IS NEW.archive_key)
     )
     BEGIN
       SELECT RAISE(ABORT, 'audit_log is append-only');
     END`
  ).run();
}

describe("expireOldEntries pre-expiry re-verification (Ruling 40)", () => {
  it("tampering the middle of a verified prefix expires only the rows before it, and records verify_failed_at", async () => {
    const old = new Date(Date.now() - 2200 * 24 * 3600 * 1000).toISOString();
    const rec = createAuditRecorder({ db: E.DB, worker: "t", via: "cron", actor: { type: "system" }, requestId: null });
    for (let i = 0; i < 3; i++) await rec.write({ action: "audit.verify", outcome: "succeeded", occurredAt: old, details: { i } });
    await runSealer(E); // seals AND archives all 3 as seq 1-3

    await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = 3 WHERE id = 1").run();

    // Direct D1 tamper (an attacker with database access), same pattern as
    // audit-verify.test.ts's "catches a naive edit" case: forge `reason`
    // without recomputing entry_hash/chain_hash, restoring the append-only
    // guard immediately after.
    await dropTriggers();
    try {
      await E.DB.prepare("UPDATE audit_log SET reason = 'forged' WHERE seq = 2").run();
    } finally {
      await restoreTriggers();
    }

    const deleted = await expireOldEntries(E.DB, E.AUDIT_ARCHIVE, new Date(), 500);
    expect(deleted).toBe(1); // only seq 1, the row before the tampered one

    const remaining = await E.DB.prepare("SELECT seq FROM audit_log WHERE seq IS NOT NULL ORDER BY seq").all<{ seq: number }>();
    expect((remaining.results ?? []).map((r) => r.seq)).toEqual([2, 3]);

    const entry = await E.DB.prepare(
      "SELECT outcome, details_json FROM audit_log WHERE action = 'audit.expire' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ outcome: string; details_json: string }>();
    expect(entry!.outcome).toBe("succeeded");
    const details = JSON.parse(entry!.details_json) as {
      verify_failed_at: number | null;
      from_seq: number;
      to_seq: number;
      count: number;
    };
    expect(details).toMatchObject({ verify_failed_at: 2, from_seq: 1, to_seq: 1, count: 1 });
  });

  it("a tampered first candidate deletes nothing and writes a failed entry", async () => {
    // Continues in the same file's D1: seq 1 was deleted by the test above;
    // seq 2 (still tampered, left in place -- only the trigger was restored,
    // not the forged row) is now the earliest surviving row, so this expiry
    // attempt hits the very same tamper as its own first candidate.
    const before = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE seq IS NOT NULL").first<{ n: number }>();

    const deleted = await expireOldEntries(E.DB, E.AUDIT_ARCHIVE, new Date(), 500);
    expect(deleted).toBe(0);

    const after = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE seq IS NOT NULL").first<{ n: number }>();
    expect(after!.n).toBe(before!.n); // nothing deleted

    const entry = await E.DB.prepare(
      "SELECT outcome, reason, details_json FROM audit_log WHERE action = 'audit.expire' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ outcome: string; reason: string | null; details_json: string }>();
    expect(entry!.outcome).toBe("failed");
    expect(entry!.reason).toBe("pre-expiry verification failed");
    const details = JSON.parse(entry!.details_json) as { verify_failed_at: number | null; from_seq: number; to_seq: number };
    expect(details).toMatchObject({ verify_failed_at: 2, from_seq: 2, to_seq: 3 });
  });
});
