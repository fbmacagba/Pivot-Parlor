import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { systemAudit } from "../src/audit/context";
import { runSealer } from "../src/audit/sealer";
import { runAuditNightly } from "../src/audit/nightly";

// Own file (own vitest-pool-workers D1), same reason as
// audit-nightly-walk-wrap.test.ts and audit-verify-expired-seq.test.ts: each
// test here plants a row (or a seal-state value) into a shape that can only
// exist through direct D1 tampering, and reasons about it against a small,
// otherwise-clean trail rather than whatever earlier describe blocks in a
// shared file left behind.

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket; RESEND_API_KEY?: string };
const OWNER_EMAIL = "owner@test.local";

function withEnv(overrides: Record<string, unknown> = {}) {
  return { ...E, RESEND_API_KEY: "re_test", AUDIT_OPERATOR_EMAIL: OWNER_EMAIL, ...overrides };
}

async function sealedTrail(n: number) {
  for (let i = 0; i < n; i++) await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { i } });
  await runSealer(E);
  const max = await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>();
  return max!.m;
}

async function dropTriggers() {
  await E.DB.prepare("DROP TRIGGER IF EXISTS audit_log_seal_only").run();
}

// See the identical helper's own comment in audit-nightly.test.ts: one
// runSealer(E) call archives only the globally oldest unarchived batch, and
// runAuditNightly's own audit.verify write is an unsealed row when it lands
// -- draining until nothing is left pending resolves both the seal stage
// and the archive stage of that lag, not just one.
async function drainSealer() {
  for (let i = 0; i < 5; i++) {
    const r = await runSealer(E);
    if (!r.sealed && !r.archived) break;
  }
}

async function latestVerifyEntry() {
  return E.DB.prepare(
    "SELECT outcome, reason, details_json FROM audit_log WHERE action = 'audit.verify' AND via = 'cron' AND details_json LIKE '%checked%' ORDER BY occurred_at DESC LIMIT 1"
  ).first<{ outcome: string; reason: string | null; details_json: string }>();
}

async function sealState() {
  return E.DB.prepare("SELECT last_verified_seq, walk_cursor_seq, expired_through_seq FROM audit_seal_state WHERE id = 1")
    .first<{ last_verified_seq: number; walk_cursor_seq: number; expired_through_seq: number }>();
}

describe("runAuditNightly timestamp-free invariants (Ruling 35)", () => {
  it("(a) flags a row that has a seq but no seal time", async () => {
    await drainSealer(); // start from a genuinely empty backlog
    const max = await sealedTrail(2);
    await dropTriggers();
    // A legitimate row never reaches seq NOT NULL / sealed_at NULL: sealBatch
    // sets both columns in the SAME UPDATE. Simulate an attacker planting a
    // seq directly onto an otherwise-unsealed row.
    const id = await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded" });
    const bogusSeq = max + 1;

    try {
      await E.DB.prepare("UPDATE audit_log SET seq = ? WHERE id = ?").bind(bogusSeq, id).run();

      await runAuditNightly(withEnv(), new Date(), async () => {});

      const entry = await latestVerifyEntry();
      const details = JSON.parse(entry!.details_json) as { impossibleSealed: number };
      expect(details.impossibleSealed).toBe(1);
      expect(entry!.reason).toMatch(/impossible state \(sealed without a seal time\)/);
    } finally {
      // Restore so the planted seq does not permanently occupy a slot and
      // inflate MAX(seq) for whatever runs after this test.
      await E.DB.prepare("UPDATE audit_log SET seq = NULL WHERE id = ?").bind(id).run();
    }
  });

  it("(b) flags a row at or below last_verified_seq that is missing its archive", async () => {
    await drainSealer(); // start from a genuinely empty backlog
    const max = await sealedTrail(3);
    await runAuditNightly(withEnv(), new Date(), async () => {}); // catch last_verified_seq up to max
    expect((await sealState())!.last_verified_seq).toBe(max);

    await dropTriggers();
    const victimSeq = max - 1;
    const original = await E.DB.prepare("SELECT archived_at, archive_key FROM audit_log WHERE seq = ?")
      .bind(victimSeq).first<{ archived_at: string; archive_key: string }>();
    // A legitimate row can never be at or below last_verified_seq without
    // being archived: verifyRange's own requireArchived gate (Ruling 28)
    // would have refused to advance last_verified_seq past it otherwise. So
    // this state only exists if something un-archived an already-verified
    // row after the fact.
    await E.DB.prepare("UPDATE audit_log SET archived_at = NULL, archive_key = NULL WHERE seq = ?").bind(victimSeq).run();

    try {
      await runAuditNightly(withEnv(), new Date(), async () => {});

      const entry = await latestVerifyEntry();
      const details = JSON.parse(entry!.details_json) as { impossibleVerifiedUnarchived: number };
      expect(details.impossibleVerifiedUnarchived).toBe(1);
      expect(entry!.reason).toMatch(/impossible state \(verified but not fully archived\)/);
    } finally {
      // Restore the row's REAL archived_at/archive_key (its R2 object still
      // holds the matching content, since we never touched it) rather than
      // leaving it unarchived -- archivePending would never pick this row
      // back up on its own (its query only looks for archived_at IS NULL,
      // and archive_key alone being NULL is invisible to it), so an
      // un-restored row here would corrupt every later test in this file.
      await E.DB.prepare("UPDATE audit_log SET archived_at = ?, archive_key = ? WHERE seq = ?")
        .bind(original!.archived_at, original!.archive_key, victimSeq).run();
    }
  });

  it("(c) flags a row that is archived but has no archive key", async () => {
    await drainSealer(); // start from a genuinely empty backlog
    const max = await sealedTrail(2);
    await dropTriggers();
    const original = await E.DB.prepare("SELECT archive_key FROM audit_log WHERE seq = ?")
      .bind(max).first<{ archive_key: string }>();
    // A legitimate row can never be archived without an archive_key:
    // archivePending sets both columns in the SAME UPDATE.
    await E.DB.prepare("UPDATE audit_log SET archive_key = NULL WHERE seq = ?").bind(max).run();

    try {
      await runAuditNightly(withEnv(), new Date(), async () => {});

      const entry = await latestVerifyEntry();
      const details = JSON.parse(entry!.details_json) as { impossibleArchivedNoKey: number };
      expect(details.impossibleArchivedNoKey).toBe(1);
      expect(entry!.reason).toMatch(/impossible state \(archived without an archive key\)/);
    } finally {
      // Same reasoning as (b)'s cleanup: restore the real key rather than
      // leave this row permanently invisible to archivePending's own query.
      await E.DB.prepare("UPDATE audit_log SET archive_key = ? WHERE seq = ?").bind(original!.archive_key, max).run();
    }
  });

  it("(d) flags an inconsistent retention boundary (expired_through_seq ahead of verified history)", async () => {
    await drainSealer(); // start from a genuinely empty backlog
    const max = await sealedTrail(2);
    await runAuditNightly(withEnv(), new Date(), async () => {}); // catch last_verified_seq up to max
    expect((await sealState())!.last_verified_seq).toBe(max);

    const originalExpired = (await sealState())!.expired_through_seq;
    try {
      // A legitimate retention sweep (Task 10) only ever advances
      // expired_through_seq to at or behind last_verified_seq. Moving it
      // AHEAD of last_verified_seq also, unavoidably, puts every existing
      // row's seq at or below it -- both halves of invariant (d) are one
      // and the same tamper here, so the count is max (every row) + 1 (the
      // boundary-ahead-of-verified-history clause itself), not just 1.
      await E.DB.prepare("UPDATE audit_seal_state SET expired_through_seq = ? WHERE id = 1").bind(max + 5).run();

      await runAuditNightly(withEnv(), new Date(), async () => {});

      const entry = await latestVerifyEntry();
      const details = JSON.parse(entry!.details_json) as { impossibleExpiry: number };
      expect(details.impossibleExpiry).toBe(max + 1);
      expect(entry!.reason).toMatch(/impossible state \(expired retention inconsistent with verified history\)/);
    } finally {
      await E.DB.prepare("UPDATE audit_seal_state SET expired_through_seq = ? WHERE id = 1").bind(originalExpired).run();
    }
  });
});

describe("runAuditNightly top-level crash guard (Ruling 36)", () => {
  it("still records a failed entry and attempts the alert when the state read itself throws", async () => {
    await drainSealer(); // start from a genuinely empty backlog
    // Make the very first query in the body throw, before any of the
    // per-step guards further down even exist yet.
    await E.DB.prepare("ALTER TABLE audit_seal_state RENAME TO audit_seal_state_renamed_for_test").run();

    const calls: string[] = [];
    const send = async (_k: string, _to: string, subject: string) => { calls.push(subject); };

    try {
      await runAuditNightly(withEnv(), new Date(), send);

      // Not latestVerifyEntry(): the crash path writes a plain entry with no
      // details_json at all, which that helper's own query would not match.
      const entry = await E.DB.prepare(
        "SELECT outcome, reason FROM audit_log WHERE action = 'audit.verify' ORDER BY occurred_at DESC LIMIT 1"
      ).first<{ outcome: string; reason: string | null }>();
      expect(entry!.outcome).toBe("failed");
      expect(entry!.reason).toMatch(/^nightly check crashed: /);
      expect(calls.some((s) => /needs attention/i.test(s))).toBe(true);
    } finally {
      await E.DB.prepare("ALTER TABLE audit_seal_state_renamed_for_test RENAME TO audit_seal_state").run();
    }
  });

  // Carried Task 9 minor (b): the crash entry's own reason names WHY no
  // alert was sent, same as the body's normal problem list already does for
  // every other path.
  it("appends '; alert email not configured' to the crash entry's reason when alerting isn't configured", async () => {
    await drainSealer();
    await E.DB.prepare("ALTER TABLE audit_seal_state RENAME TO audit_seal_state_renamed_for_test").run();

    const calls: string[] = [];
    const send = async (_k: string, _to: string, subject: string) => { calls.push(subject); };

    try {
      await runAuditNightly({ ...E, RESEND_API_KEY: undefined, AUDIT_OPERATOR_EMAIL: undefined }, new Date(), send);

      const entry = await E.DB.prepare(
        "SELECT outcome, reason FROM audit_log WHERE action = 'audit.verify' ORDER BY occurred_at DESC LIMIT 1"
      ).first<{ outcome: string; reason: string | null }>();
      expect(entry!.outcome).toBe("failed");
      expect(entry!.reason).toMatch(/^nightly check crashed: .+; alert email not configured$/);
      expect(calls.length).toBe(0);
    } finally {
      await E.DB.prepare("ALTER TABLE audit_seal_state_renamed_for_test RENAME TO audit_seal_state").run();
    }
  });
});
