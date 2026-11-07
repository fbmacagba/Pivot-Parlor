import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuditRecorder } from "@repo/audit";
import { runSealer } from "../src/audit/sealer";
import { verifyRange } from "../src/audit/verify";
import { runAuditNightly } from "../src/audit/nightly";
import { expireOldEntries } from "../src/audit/retention";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket; RESEND_API_KEY?: string };
const OWNER_EMAIL = "owner@test.local";

function withEnv(overrides: Record<string, unknown> = {}) {
  return { ...E, RESEND_API_KEY: "re_test", AUDIT_OPERATOR_EMAIL: OWNER_EMAIL, ...overrides };
}

// Same pattern as the identical helper in the nightly test files: one
// runSealer(E) call archives only the globally oldest unarchived batch, so
// draining until nothing is left pending resolves both the seal stage and
// the archive stage of any lag.
async function drainSealer() {
  for (let i = 0; i < 5; i++) {
    const r = await runSealer(E);
    if (!r.sealed && !r.archived) break;
  }
}

// Its own file (own vitest-pool-workers D1), so the old entry below is the
// very first one in the chain and therefore an expirable prefix:
// expireOldEntries only deletes a contiguous prefix of the chain, and an old
// row that was sealed after younger ones (sealing order, not occurrence
// order) waits until everything before it has expired.

describe("audit expiry", () => {
  // Ruling 38: expireOldEntries may only expire rows with
  // seq <= audit_seal_state.last_verified_seq -- an unverified row can never
  // be expired, however old and however archived it already is. On a fresh
  // trail last_verified_seq defaults to 0 (migration 046), so this old,
  // archived, seq-1 row must NOT be expired yet.
  it("does not expire an old, archived row until the verifier has caught up to it", async () => {
    const old = new Date(Date.now() - 2200 * 24 * 3600 * 1000).toISOString();
    const rec = createAuditRecorder({ db: E.DB, worker: "t", via: "cron", actor: { type: "system" }, requestId: null });
    await rec.write({ action: "audit.verify", outcome: "succeeded", occurredAt: old });
    await runSealer(E); // seals AND archives it as seq 1, the very first entry in the chain

    const before = await E.DB.prepare("SELECT last_verified_seq FROM audit_seal_state WHERE id = 1").first<{ last_verified_seq: number }>();
    expect(before!.last_verified_seq).toBe(0); // nothing has verified it yet

    const deleted = await expireOldEntries(E.DB, E.AUDIT_ARCHIVE, new Date(), 500);
    expect(deleted).toBe(0);

    const row = await E.DB.prepare("SELECT seq FROM audit_log WHERE seq = 1").first();
    expect(row).not.toBeNull();
  });

  it("expires archived entries older than 6 years once verified, and the rest still verifies", async () => {
    // Continues in the same file's D1: seq 1 is still the old row from the
    // test above, still unexpired.
    const rec = createAuditRecorder({ db: E.DB, worker: "t", via: "cron", actor: { type: "system" }, requestId: null });
    await rec.write({ action: "audit.verify", outcome: "succeeded" }); // recent, becomes seq 2
    await runSealer(E);
    const max0 = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;

    // Simplest faithful stand-in for "the nightly verifier has confirmed
    // this range": actually run verifyRange (the same check runAuditNightly
    // itself calls) and, once it passes, advance last_verified_seq to what
    // runAuditNightly would have advanced it to -- without driving the whole
    // nightly cron, which would write its own audit.verify row and shift the
    // seq numbers this test depends on.
    expect((await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1, max0)).ok).toBe(true);
    await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = ? WHERE id = 1").bind(max0).run();

    const deleted = await expireOldEntries(E.DB, E.AUDIT_ARCHIVE, new Date(), 500);
    expect(deleted).toBe(1);

    await runSealer(E);
    const st = await E.DB.prepare("SELECT expired_through_seq FROM audit_seal_state WHERE id = 1").first<{ expired_through_seq: number }>();
    const max = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;
    expect((await verifyRange(E.DB, E.AUDIT_ARCHIVE, st!.expired_through_seq + 1, max)).ok).toBe(true);
  });

  // Dispatch requirement: after expiring rows, runAuditNightly must produce
  // no impossible-state problem line (nightly.ts invariant checks (a)-(d)).
  // Continues in the same file's D1: seq 1 was deleted by the test above,
  // expired_through_seq = 1, last_verified_seq = 2 (the pre-expiry max).
  it("runAuditNightly reports no impossible-state problem after expiry, and crosses the deleted-seq-1 boundary", async () => {
    await drainSealer(); // fully seal + archive the audit.expire entry itself

    await runAuditNightly(withEnv(), new Date(), async () => {});

    const entry = await E.DB.prepare(
      "SELECT reason, details_json FROM audit_log WHERE action = 'audit.verify' AND via = 'cron' AND details_json LIKE '%checked%' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ reason: string | null; details_json: string }>();
    const details = JSON.parse(entry!.details_json) as {
      impossibleSealed: number;
      impossibleVerifiedUnarchived: number;
      impossibleArchivedNoKey: number;
      impossibleExpiry: number;
      walk: { from: number; ok: boolean } | null;
    };
    expect(details.impossibleSealed).toBe(0);
    expect(details.impossibleVerifiedUnarchived).toBe(0);
    expect(details.impossibleArchivedNoKey).toBe(0);
    expect(details.impossibleExpiry).toBe(0);
    expect(entry!.reason ?? "").not.toMatch(/impossible state/);

    // Non-vacuous: the walk's `from` (the floor, seq 2) proves it actually
    // crossed the deleted seq-1 boundary and had to seed its starting
    // chain_hash from audit_seal_state.expired_chain_hash rather than a
    // stored row (seq 1 no longer exists) -- not merely that nothing ran.
    expect(details.walk?.from).toBe(2);
    expect(details.walk?.ok).toBe(true);
  });
});
