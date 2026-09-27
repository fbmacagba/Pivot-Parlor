import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { systemAudit } from "../src/audit/context";
import { runSealer } from "../src/audit/sealer";
import { runAuditNightly } from "../src/audit/nightly";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket; RESEND_API_KEY?: string };

// A separate file from audit-verify.test.ts (own vitest-pool-workers D1) on
// purpose: the "verifyRange" describe block over there deliberately, and
// permanently, corrupts seq 2 (and every later chain_hash from seq 3 on) to
// prove that only the immutable archive catches a full chain-recompute
// attack. Sharing a file with those tests would mean this suite's own
// incremental/rotating-walk scan — which starts from seq 1 on a fresh trail —
// rediscovers that same deliberate tampering and reports "failed" instead of
// "succeeded", for a reason unrelated to what this file tests. See
// task-9-report.md for the reproduction and the two adaptations considered.

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

// archivePending (Ruling 24) archives only the globally OLDEST unarchived
// seal batch per call. runAuditNightly's own audit.verify write is itself an
// unsealed row when it lands, so a single runSealer(E) call after a
// deliberately-backdated row often just seals THAT trailing entry (giving it
// its own fresh, distinct sealed_at) without also archiving it -- one call
// resolves one stage of a two-stage lag (seal, then archive), not both. Loop
// until nothing is left pending, so a test using this to clean up after
// itself leaves a genuinely empty backlog for the next test.
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

describe("runAuditNightly", () => {
  it("records an audit.verify entry, emails the anchor, and advances both cursors", async () => {
    const clock = new Date(); // capture once (minor: avoid a second, later new Date())
    const tomorrow = new Date(clock.getTime() + 24 * 3600 * 1000);
    await sealedTrail(2);
    const maxSeq = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;

    const sent: { subject: string; lines: string[] }[] = [];
    await runAuditNightly(withEnv(), tomorrow, async (_k, _to, subject, lines) => { sent.push({ subject, lines }); });

    const entry = await latestVerifyEntry();
    expect(entry!.outcome).toBe("succeeded");
    expect(sent.some((m) => /anchor/i.test(m.subject))).toBe(true);
    const anchorKey = `anchors/${clock.toISOString().slice(0, 10)}.json`;
    expect(await E.AUDIT_ARCHIVE.head(anchorKey)).not.toBeNull();

    // Ruling 31: a clean run advances both cursors to the end of what it checked.
    const state = await sealState();
    expect(state!.last_verified_seq).toBe(maxSeq);
    expect(state!.walk_cursor_seq).toBe(maxSeq);
  });

  // Ruling 31: a persistently-bad row (here, a tampered entry_hash) must not
  // freeze verification of every row after it.
  it("advances past a tampered row without stalling verification of later rows", async () => {
    const state0 = await sealState();
    const tamperSeq = state0!.last_verified_seq + 1;
    await sealedTrail(1); // seals tamperSeq
    await dropTriggers();
    await E.DB.prepare("UPDATE audit_log SET reason = 'forged' WHERE seq = ?").bind(tamperSeq).run();
    await sealedTrail(2); // seal 2 clean rows AFTER the tampered one
    const maxSeq = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;

    // Real "now" throughout this test (not an artificially advanced clock):
    // a later call in the SAME test would otherwise see the previous call's
    // own still-unsealed audit.verify write as "unsealed for more than 10
    // minutes" purely because the 10-minute threshold is computed relative
    // to whatever `now` is passed in, not real wall-clock time.
    await runAuditNightly(withEnv(), new Date(), async () => {});

    const entry = await latestVerifyEntry();
    const details = JSON.parse(entry!.details_json) as { incremental: { firstBadSeq: number | null; ok: boolean } | null };
    expect(details.incremental?.ok).toBe(false);
    expect(details.incremental?.firstBadSeq).toBe(tamperSeq);

    const state = await sealState();
    // Advanced PAST the known-bad row (not stuck at tamperSeq - 1), so the
    // rows sealed after it are reachable on a later run. The rotating walk
    // hits the exact same tampered row on the same range this run (both
    // cursors started at the same place) and must advance past it too, not
    // reset to 0 (which would restart the whole re-walk from the floor
    // forever instead of moving on).
    expect(state!.last_verified_seq).toBe(tamperSeq);
    expect(state!.walk_cursor_seq).toBe(tamperSeq);

    // A second run resumes right after the tampered row (X+1) and clears the rest.
    await runAuditNightly(withEnv(), new Date(), async () => {});
    const state2 = await sealState();
    expect(state2!.last_verified_seq).toBe(maxSeq);
    const entry2 = await latestVerifyEntry();
    expect(entry2!.outcome).toBe("succeeded");
    const details2 = JSON.parse(entry2!.details_json) as { incremental: { from: number } | null };
    expect(details2.incremental?.from).toBe(tamperSeq + 1);
  });

  // Ruling 31: an interior GAP (not merely a bad row) has no stored
  // chain_hash to seed from at the missing seq itself, so it takes one more
  // night than the tamper case to resolve — recorded in task-9-report.md.
  it("resolves an interior gap over successive nights instead of stalling forever", async () => {
    await sealedTrail(5);
    const maxBefore = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;
    const gapSeq = maxBefore - 2;
    await dropTriggers(); // idempotent; may already be dropped by an earlier test
    await E.DB.prepare("UPDATE audit_log SET seq = NULL WHERE seq = ?").bind(gapSeq).run();

    const noop = async () => {};
    await runAuditNightly(withEnv(), new Date(), noop); // night 1
    let state = await sealState();
    expect(state!.last_verified_seq).toBe(gapSeq);

    await runAuditNightly(withEnv(), new Date(), noop); // night 2
    state = await sealState();
    expect(state!.last_verified_seq).toBe(gapSeq + 1);

    await runAuditNightly(withEnv(), new Date(), noop); // night 3: past the gap
    state = await sealState();
    expect(state!.last_verified_seq).toBeGreaterThanOrEqual(maxBefore);
    const entry = await latestVerifyEntry();
    expect(entry!.outcome).toBe("succeeded");
  });

  it("wraps the rotating walk back to the floor once it has caught up to the end of history", async () => {
    await sealedTrail(1);
    const maxSeq = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;
    const state0 = await sealState();
    // Simulate "already caught up": the walk cursor sits at the current end.
    await E.DB.prepare("UPDATE audit_seal_state SET walk_cursor_seq = ? WHERE id = 1").bind(maxSeq).run();
    const floor = (state0!.expired_through_seq ?? 0) + 1;

    await runAuditNightly(withEnv(), new Date(), async () => {});

    const entry = await latestVerifyEntry();
    const details = JSON.parse(entry!.details_json) as { walk: { from: number } | null };
    expect(details.walk?.from).toBe(floor);
  });

  it('flags "newest entries missing" when the trail\'s own MAX(seq) regresses below what was already verified', async () => {
    const maxSeq = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m ?? 0;
    await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = ? WHERE id = 1").bind(maxSeq + 5).run();

    try {
      await runAuditNightly(withEnv(), new Date(), async () => {});

      const entry = await latestVerifyEntry();
      expect(entry!.outcome).toBe("failed");
      expect(entry!.reason).toMatch(/newest entries missing/);
    } finally {
      // Leave the cursor consistent again for later tests in this file, even
      // if an assertion above throws.
      await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = ? WHERE id = 1").bind(maxSeq).run();
    }
  });

  it("flags a mismatch when a stored anchor no longer matches the live chain", async () => {
    const clock = new Date(); // real now: this test's own check doesn't need the anchor-write boundary
    const today = clock.toISOString().slice(0, 10);
    const dayBefore = new Date(Date.parse(`${today}T00:00:00.000Z`) - 2 * 24 * 3600_000).toISOString().slice(0, 10);

    const seq = await sealedTrail(1);
    await E.AUDIT_ARCHIVE.put(`anchors/${dayBefore}.json`, JSON.stringify({ date: dayBefore, seq, chain_hash: "bogus" }));

    await runAuditNightly(withEnv(), clock, async () => {});

    const entry = await latestVerifyEntry();
    expect(entry!.outcome).toBe("failed");
    expect(entry!.reason).toMatch(/no longer matches the chain/);
  });

  it("sends the anchor email using the stored anchor value, not a freshly recomputed one", async () => {
    const clock = new Date();
    const tomorrow = new Date(clock.getTime() + 24 * 3600_000);
    const today = tomorrow.toISOString().slice(0, 10);
    const yesterday = new Date(Date.parse(`${today}T00:00:00.000Z`) - 24 * 3600_000).toISOString().slice(0, 10);

    await sealedTrail(1);
    const rowA = await E.DB.prepare("SELECT seq, chain_hash FROM audit_log WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .first<{ seq: number; chain_hash: string }>();
    // Pre-plant yesterday's anchor as if a previous night already wrote it,
    // pointing at rowA — a real, currently-correct value.
    await E.AUDIT_ARCHIVE.put(`anchors/${yesterday}.json`, JSON.stringify({ date: yesterday, seq: rowA!.seq, chain_hash: rowA!.chain_hash }));

    // Seal MORE rows afterward. A freshly recomputed "last sealed row before
    // today" would now pick up rowB instead of rowA.
    await sealedTrail(2);

    const sent: { subject: string; lines: string[] }[] = [];
    await runAuditNightly(withEnv(), tomorrow, async (_k, _to, subject, lines) => { sent.push({ subject, lines }); });

    const anchorMail = sent.find((m) => /anchor/i.test(m.subject));
    expect(anchorMail).toBeDefined();
    expect(anchorMail!.lines.some((l) => l.includes(String(rowA!.seq)))).toBe(true);
    expect(anchorMail!.lines.some((l) => l.includes(rowA!.chain_hash))).toBe(true);
  });

  // Ruling 32.
  it("sends alert/anchor mail to AUDIT_OPERATOR_EMAIL, never to a D1 platform_users address", async () => {
    await E.DB.prepare(
      "INSERT OR IGNORE INTO platform_users (id, name, email, password_hash, role) VALUES ('dev-recipient-test', 'Dev', 'should-never-be-used@d1.example', 'x', 'developer')"
    ).run();
    await sealedTrail(1);
    // Force a problem so the alert path (not just any leftover anchor) is
    // guaranteed to fire, independent of anchor-boundary timing.
    const maxSeq = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m ?? 0;
    await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = ? WHERE id = 1").bind(maxSeq + 5).run();

    const sent: { to: string; subject: string }[] = [];
    try {
      await runAuditNightly(withEnv(), new Date(), async (_k, to, subject) => { sent.push({ to, subject }); });

      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((m) => m.to === OWNER_EMAIL)).toBe(true);
      expect(sent.some((m) => m.to === "should-never-be-used@d1.example")).toBe(false);
    } finally {
      // Leave the cursor consistent again for later tests in this file.
      await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = ? WHERE id = 1").bind(maxSeq).run();
    }
  });

  it('records "alert email not configured" when AUDIT_OPERATOR_EMAIL or RESEND_API_KEY is unset', async () => {
    const sentA: unknown[] = [];
    await runAuditNightly({ ...E, RESEND_API_KEY: undefined, AUDIT_OPERATOR_EMAIL: undefined }, new Date(), async (...args) => { sentA.push(args); });
    let entry = await latestVerifyEntry();
    expect(entry!.outcome).toBe("failed");
    expect(entry!.reason).toMatch(/alert email not configured/);
    expect(sentA.length).toBe(0);

    const sentB: unknown[] = [];
    await runAuditNightly({ ...E, RESEND_API_KEY: "re_test", AUDIT_OPERATOR_EMAIL: undefined }, new Date(), async (...args) => { sentB.push(args); });
    entry = await latestVerifyEntry();
    expect(entry!.reason).toMatch(/alert email not configured/);
    expect(sentB.length).toBe(0);

    // Recipient set, RESEND_API_KEY unset: also unconfigured (a Boolean(recipient)
    // check alone would incorrectly pass this case).
    const sentC: unknown[] = [];
    await runAuditNightly({ ...E, RESEND_API_KEY: undefined, AUDIT_OPERATOR_EMAIL: OWNER_EMAIL }, new Date(), async (...args) => { sentC.push(args); });
    entry = await latestVerifyEntry();
    expect(entry!.reason).toMatch(/alert email not configured/);
    expect(sentC.length).toBe(0);
  });

  // Ruling 30: a failed WRITE may not swallow the alert send.
  it("still attempts the alert email when the audit.verify write itself throws", async () => {
    const seq = await sealedTrail(1);
    const maxSeq = seq;
    // Force a problem so the alert path has something to send.
    await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = ? WHERE id = 1").bind(maxSeq + 5).run();

    const realBatch = E.DB.batch.bind(E.DB);
    (E.DB as unknown as { batch: typeof E.DB.batch }).batch = (() => {
      throw new Error("db down");
    }) as unknown as typeof E.DB.batch;

    const calls: string[] = [];
    const send = async (_k: string, _to: string, subject: string) => { calls.push(subject); };

    try {
      await runAuditNightly(withEnv(), new Date(), send);
      expect(calls.some((s) => /needs attention/i.test(s))).toBe(true);
    } finally {
      (E.DB as unknown as { batch: typeof E.DB.batch }).batch = realBatch;
      // Restore the cursor the forced problem left behind, for later tests
      // (in a finally so a failed assertion above still cleans up).
      await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = ? WHERE id = 1").bind(maxSeq).run();
    }
  });

  // Ruling 30 / minors: a failed alert SEND may not swallow the anchor send,
  // and the audit.verify entry must still get written (the real db.batch is
  // used this time, unlike the write-throws test above).
  it("still attempts the anchor email when the alert send throws, and still writes the audit.verify entry", async () => {
    const clock = new Date();
    const today = clock.toISOString().slice(0, 10);
    const yesterday = new Date(Date.parse(`${today}T00:00:00.000Z`) - 24 * 3600_000).toISOString().slice(0, 10);

    const seq = await sealedTrail(1);
    const row = await E.DB.prepare("SELECT chain_hash FROM audit_log WHERE seq = ?").bind(seq).first<{ chain_hash: string }>();
    // Plant a valid anchor for "yesterday" (real now) directly, so the
    // anchor email has something to send without needing an artificially
    // advanced clock (which would make the previous call's own still-
    // unsealed write look stale — see the tamper-advance test above).
    await E.AUDIT_ARCHIVE.put(`anchors/${yesterday}.json`, JSON.stringify({ date: yesterday, seq, chain_hash: row!.chain_hash }));

    const maxSeq = seq;
    // Force a problem so the alert path has something to send.
    await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = ? WHERE id = 1").bind(maxSeq + 5).run();

    const countBefore = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.verify' AND details_json LIKE '%checked%'").first<{ n: number }>();

    const calls: string[] = [];
    const throwOnAnchor = async (_k: string, _to: string, subject: string) => {
      calls.push(subject);
      if (/anchor/i.test(subject)) throw new Error("send down");
    };

    try {
      await runAuditNightly(withEnv(), clock, throwOnAnchor);

      expect(calls.some((s) => /needs attention/i.test(s))).toBe(true);
      expect(calls.some((s) => /anchor/i.test(s))).toBe(true);

      const countAfter = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.verify' AND details_json LIKE '%checked%'").first<{ n: number }>();
      expect(countAfter!.n).toBe(countBefore!.n + 1);
    } finally {
      await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = ? WHERE id = 1").bind(maxSeq).run();
    }
  });

  // Ruling 30: a bucket that throws on every call must not throw OUT of
  // runAuditNightly — each guarded step (verify, anchor write, anchor
  // readback) turns into its own problem line instead.
  it("turns a completely failing bucket into problem lines instead of throwing", async () => {
    const clock = new Date(Date.now() + 24 * 3600_000); // tomorrow, so anchorRow exists and the write guard actually runs
    await sealedTrail(1);

    const throwingBucket = {
      head: async () => { throw new Error("r2 down"); },
      get: async () => { throw new Error("r2 down"); },
      put: async () => { throw new Error("r2 down"); },
      delete: async () => { throw new Error("r2 down"); },
    } as unknown as R2Bucket;

    const sent: { subject: string; lines: string[] }[] = [];
    await runAuditNightly(withEnv({ AUDIT_ARCHIVE: throwingBucket }), clock, async (_k, _to, subject, lines) => { sent.push({ subject, lines }); });

    const alertMail = sent.find((m) => /needs attention/i.test(m.subject));
    expect(alertMail).toBeDefined();
    expect(alertMail!.lines.some((l) => l.includes("verify error: Error"))).toBe(true);
    expect(alertMail!.lines.some((l) => l.includes("could not write anchor"))).toBe(true);
    expect(alertMail!.lines.some((l) => l.includes("could not verify stored anchor"))).toBe(true);
  });

  // Ruling 33: archivedCeiling (Ruling 28, above) can silently stop BOTH the
  // incremental scan and the rotating walk well short of MAX(seq) when one
  // row never finishes archiving -- name the seq once it has been stuck
  // long enough to rule out ordinary archiver lag. Both tests below
  // construct that DB state directly (dropTriggers + raw UPDATE), the same
  // way the interior-gap and NULL-archive_key tests in audit-verify.test.ts
  // do, rather than through the sealer: archivePending always retries the
  // globally OLDEST unarchived batch first (Ruling 24's one-batch-per-call
  // design), so there is no way to make the real sealer leave an OLD row
  // stuck while a NEWER one archives fine in the same run -- the very next
  // real runSealer(E) call would just archive the old one instead. Each
  // test drains the sealer for real in a `finally` (proper key, proper
  // content, and past both stages of the seal-then-archive lag described
  // above on drainSealer) so nothing leaks into the tests that follow.
  it("names the seq where verification is blocked by a row stuck unarchived for over an hour (Ruling 33)", async () => {
    await drainSealer(); // start from a genuinely empty backlog
    const max = await sealedTrail(4);
    const blockedSeq = max - 2; // leaves 2 already-archived rows sealed after it
    await dropTriggers();
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    await E.DB.prepare("UPDATE audit_log SET archived_at = NULL, archive_key = NULL, sealed_at = ? WHERE seq = ?")
      .bind(twoHoursAgo, blockedSeq).run();

    try {
      await runAuditNightly(withEnv(), new Date(), async () => {});

      const entry = await latestVerifyEntry();
      const details = JSON.parse(entry!.details_json) as { blockedAtSeq: number | null };
      expect(details.blockedAtSeq).toBe(blockedSeq);
      expect(entry!.reason).toMatch(new RegExp(`verification blocked at seq ${blockedSeq}: sealed but not archived`));
    } finally {
      // Archive the row for real so it -- and the cursor capped just below
      // it -- do not leak into later tests in this file.
      await drainSealer();
    }
  });

  it("does not raise a blocked line for a row unarchived only 5 minutes (ordinary archiver lag)", async () => {
    await drainSealer(); // start from a genuinely empty backlog
    const max = await sealedTrail(4);
    const recentSeq = max - 2;
    await dropTriggers();
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    await E.DB.prepare("UPDATE audit_log SET archived_at = NULL, archive_key = NULL, sealed_at = ? WHERE seq = ?")
      .bind(fiveMinAgo, recentSeq).run();

    try {
      await runAuditNightly(withEnv(), new Date(), async () => {});

      const entry = await latestVerifyEntry();
      const details = JSON.parse(entry!.details_json) as { blockedAtSeq: number | null };
      expect(details.blockedAtSeq).toBeNull();
      expect(entry!.reason ?? "").not.toMatch(/verification blocked/);
    } finally {
      await drainSealer();
    }
  });

  // Ruling 28. Placed immediately before the Ruling 27 test below on purpose:
  // it deliberately leaves one row sealed-but-unarchived forever (the failing
  // bucket never gets a working retry in this test), and the very next
  // test's own runSealer(E) call (real bucket) naturally archives it as part
  // of its own batch — no cleanup needed, but no test after that one may
  // depend on this row already being archived.
  it("caps the incremental scan below a row that is sealed but not yet archived", async () => {
    await sealedTrail(2);
    const beforeMax = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;

    await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded" });
    const failingBucket = { head: async () => null, get: async () => null, put: async () => { throw new Error("archive down"); } } as unknown as R2Bucket;
    await runSealer({ DB: E.DB, AUDIT_ARCHIVE: failingBucket });

    const afterMax = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;
    expect(afterMax).toBe(beforeMax + 1); // sealed, but not archived (failing bucket)

    await runAuditNightly(withEnv(), new Date(), async () => {});

    const entry = await latestVerifyEntry();
    const details = JSON.parse(entry!.details_json) as { incremental: { to: number; ok: boolean } | null };
    expect(details.incremental?.to).toBe(beforeMax);
    expect(details.incremental?.ok).toBe(true);

    const state = await sealState();
    expect(state!.last_verified_seq).toBe(beforeMax);
  });

  // Ruling 27: the nightly's "unsealed" count excludes rows that already
  // carry an audit.seal.alert (the sealer will never advance them past
  // "unsealed" — Ruling 23 — so counting them as a growing unsealed backlog
  // every night forever would be noise, not signal). They are instead
  // reported through a dedicated integrity-failure line and detail count.
  // MUST STAY LAST: it permanently leaves one row unsealed and one
  // audit.seal.alert entry that would otherwise poison every later test's
  // "succeeded" outcome assertion (sealAlerts counts entries in the last 24h).
  it("excludes a tampered, alerted row from the unsealed count and reports it as an integrity failure", async () => {
    const elevenMinAgo = new Date(Date.now() - 11 * 60_000).toISOString();
    const id = await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", occurredAt: elevenMinAgo });
    await dropTriggers();
    await E.DB.prepare("UPDATE audit_log SET reason = 'forged' WHERE id = ?").bind(id).run();
    // The sealer sees the entry_hash mismatch, never seals this row, and
    // writes it its one audit.seal.alert (Ruling 22/23) instead.
    const sealResult = await runSealer(E);
    expect(sealResult.tampered).toContain(id);

    const sent: { subject: string; lines: string[] }[] = [];
    await runAuditNightly(withEnv(), new Date(), async (_k, _to, subject, lines) => { sent.push({ subject, lines }); });

    const entry = await latestVerifyEntry();
    const details = JSON.parse(entry!.details_json) as { unsealed: number; sealAlerts: number };
    expect(details.unsealed).toBe(0);
    expect(details.sealAlerts).toBe(1);
    expect(entry!.reason).toMatch(/1 entries failed their integrity check when sealing/);
    expect(sent.some((m) => /needs attention/i.test(m.subject) && m.lines.some((l) => /failed their integrity check when sealing/.test(l)))).toBe(true);
  });
});
