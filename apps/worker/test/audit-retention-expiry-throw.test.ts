import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuditRecorder } from "@repo/audit";
import { runSealer } from "../src/audit/sealer";
import { expireOldEntries } from "../src/audit/retention";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

// Own file (own vitest-pool-workers D1): Ruling 40's "a verifyRange throw
// must not escape the sweep" path needs a genuinely archived row (a real R2
// key on file) so verifyRange gets far enough to read the archive and hit
// the throwing bucket, then swaps in a bucket that throws only for THIS
// expireOldEntries call.

describe("expireOldEntries pre-expiry verify throw (Ruling 40)", () => {
  it("treats a verifyRange throw as a failure at the first candidate, never escaping the sweep", async () => {
    const old = new Date(Date.now() - 2200 * 24 * 3600 * 1000).toISOString();
    const rec = createAuditRecorder({ db: E.DB, worker: "t", via: "cron", actor: { type: "system" }, requestId: null });
    await rec.write({ action: "audit.verify", outcome: "succeeded", occurredAt: old });
    await runSealer(E); // seals AND archives it as seq 1, with a real R2 key

    // Ruling 38 gate: without this, expireOldEntries returns 0 before ever
    // reaching the pre-expiry re-verify, and the throw path is never hit.
    await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = 1 WHERE id = 1").run();

    const throwingBucket = {
      head: async () => { throw new Error("r2 down"); },
      get: async () => { throw new Error("r2 down"); },
      put: async () => { throw new Error("r2 down"); },
      delete: async () => { throw new Error("r2 down"); },
    } as unknown as R2Bucket;

    const deleted = await expireOldEntries(E.DB, throwingBucket, new Date(), 500);
    expect(deleted).toBe(0);

    const row = await E.DB.prepare("SELECT seq FROM audit_log WHERE seq = 1").first();
    expect(row).not.toBeNull(); // nothing deleted

    const entry = await E.DB.prepare(
      "SELECT outcome, reason, details_json FROM audit_log WHERE action = 'audit.expire' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ outcome: string; reason: string | null; details_json: string }>();
    expect(entry!.outcome).toBe("failed");
    // Never err.message (Ruling 5) -- exactly the error's name, not "r2 down".
    expect(entry!.reason).toBe("pre-expiry verification error: Error");
    const details = JSON.parse(entry!.details_json) as { verify_failed_at: number | null; from_seq: number; to_seq: number };
    expect(details).toMatchObject({ verify_failed_at: 1, from_seq: 1, to_seq: 1 });
  });
});
