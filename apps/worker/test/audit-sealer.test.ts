import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chainHash, GENESIS, type AuditRow } from "@repo/audit";
import { runSealer } from "../src/audit/sealer";
import { systemAudit } from "../src/audit/context";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };
const rows = () => E.DB.prepare("SELECT * FROM audit_log WHERE seq IS NOT NULL ORDER BY seq").all<AuditRow>().then((r) => r.results ?? []);

describe("sealer", () => {
  it("seals in order, chains from GENESIS and archives", async () => {
    for (let i = 0; i < 3; i++) await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { i } });
    const res = await runSealer(E);
    expect(res).toMatchObject({ skipped: false, sealed: 3, archived: 3, tampered: [] });
    const sealed = await rows();
    expect(sealed.map((r) => r.seq)).toEqual([1, 2, 3]);
    let prev = GENESIS;
    for (const r of sealed) {
      prev = await chainHash(prev, r.entry_hash);
      expect(r.chain_hash).toBe(prev);
      expect(r.archived_at).not.toBeNull();
    }
    const obj = await E.AUDIT_ARCHIVE.get(sealed[0]!.archive_key!);
    expect((await obj!.text()).trim().split("\n")).toHaveLength(3);
  });

  it("skips while another run holds the lease", async () => {
    await E.DB.prepare("UPDATE audit_seal_state SET holder = 'other', lease_until = ? WHERE id = 1")
      .bind(new Date(Date.now() + 60_000).toISOString()).run();
    try {
      expect(await runSealer(E)).toMatchObject({ skipped: true });
    } finally {
      await E.DB.prepare("UPDATE audit_seal_state SET holder = NULL, lease_until = NULL WHERE id = 1").run();
    }
  });

  it("leaves rows unarchived when the put fails, and re-archives them next run", async () => {
    await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded" });
    const failing = { head: async () => null, get: async () => null, put: async () => { throw new Error("r2 down"); } } as unknown as R2Bucket;
    const first = await runSealer({ DB: E.DB, AUDIT_ARCHIVE: failing });
    expect(first.archiveError).toMatch(/r2 down/);
    const pending = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NOT NULL AND archived_at IS NULL").first<{ n: number }>();
    expect(pending!.n).toBeGreaterThan(0);
    const second = await runSealer(E);
    expect(second.archived).toBe(pending!.n);
  });

  it("marks a started entry with no outcome after 15 minutes as unknown, copying its request_id", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const startedId = await systemAudit(E.DB, "queue", "req-abc-123").write({ action: "ai.call", phase: "started", occurredAt: old });
    await runSealer(E);
    const child = await E.DB.prepare("SELECT outcome, phase, request_id FROM audit_log WHERE parent_id = ?").bind(startedId).first();
    expect(child).toEqual({ outcome: "unknown", phase: "outcome", request_id: "req-abc-123" });
  });

  // Ruling 26: the stale-started scan is bounded to [cutoff - 7 days, cutoff),
  // not just "< cutoff", to avoid a full-table scan over 6 years of history.
  // A row older than the lookback must never be marked unknown by the minute
  // sealer (the nightly check is the backstop for that case).
  it("does not mark a started entry older than the 7-day lookback as unknown", async () => {
    const ancient = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    const startedId = await systemAudit(E.DB, "queue").write({ action: "ai.call", phase: "started", occurredAt: ancient });
    await runSealer(E);
    const child = await E.DB.prepare("SELECT * FROM audit_log WHERE parent_id = ?").bind(startedId).first();
    expect(child).toBeNull();
    // It is still an ordinary row and still gets sealed on its own merits.
    const started = await E.DB.prepare("SELECT sealed_at FROM audit_log WHERE id = ?").bind(startedId).first<{ sealed_at: string | null }>();
    expect(started!.sealed_at).not.toBeNull();
  });

  it("archivePending accepts an identical pre-existing object", async () => {
    const { archivePending, archiveKey } = await import("../src/audit/sealer");
    await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded" });
    await runSealer({ DB: E.DB, AUDIT_ARCHIVE: { head: async () => null, get: async () => null, put: async () => { throw new Error("down"); } } as unknown as R2Bucket });
    const pending = (await E.DB.prepare("SELECT * FROM audit_log WHERE sealed_at IS NOT NULL AND archived_at IS NULL ORDER BY seq").all<AuditRow>()).results!;
    const { archiveLine } = await import("@repo/audit");
    const body = pending.map(archiveLine).join("\n") + "\n";
    const key = archiveKey(pending[0]!.seq!, pending[pending.length - 1]!.seq!, pending[0]!.sealed_at!);
    await E.AUDIT_ARCHIVE.put(key, body);
    expect(await archivePending(E.DB, E.AUDIT_ARCHIVE, new Date().toISOString())).toBe(pending.length);
  });

  // Ruling 24: archivePending archives exactly one seal batch (one shared
  // sealed_at) per call, with a key deterministic from that batch alone, so
  // a lost archived_at update recovers without ever writing a second object
  // - and without pulling a later, still-unarchived batch's rows into it.
  it("recovers a lost archived_at update without writing a second object, and leaves a later batch for its own run", async () => {
    for (let i = 0; i < 3; i++) await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { batch: 1, i } });
    const firstRun = await runSealer(E);
    expect(firstRun).toMatchObject({ sealed: 3, archived: 3 });

    const batch1 = (
      await E.DB.prepare("SELECT * FROM audit_log WHERE sealed_at IS NOT NULL ORDER BY seq DESC LIMIT 3").all<AuditRow>()
    ).results!.reverse();
    const key1 = batch1[0]!.archive_key!;
    const bodyBefore = await (await E.AUDIT_ARCHIVE.get(key1))!.text();
    // Snapshotted AFTER key1 exists (this file's bucket is shared across every
    // test, so other tests' objects may already be present); the assertion
    // below only needs "no object was ADDED", not "exactly one object total".
    const keysBeforeRecovery = (await E.AUDIT_ARCHIVE.list()).objects.map((o) => o.key).sort();

    // Simulate a put that succeeded but whose archived_at/archive_key UPDATE
    // was lost (e.g. a crash between the two): audit_log_seal_only forbids
    // un-setting archived_at once non-null, so drop/restore the trigger the
    // same way the tamper test does, rather than leaving a permanent gap in
    // the append-only guard for the rest of the suite.
    const trig = await E.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_log_seal_only'")
      .first<{ sql: string }>();
    await E.DB.prepare("DROP TRIGGER audit_log_seal_only").run();
    try {
      await E.DB.prepare("UPDATE audit_log SET archived_at = NULL, archive_key = NULL WHERE id IN (?, ?, ?)")
        .bind(batch1[0]!.id, batch1[1]!.id, batch1[2]!.id)
        .run();
    } finally {
      await E.DB.prepare(trig!.sql).run();
    }

    // A new row is sealed into its OWN, later batch before the recovery run.
    await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { batch: 2 } });
    const secondRun = await runSealer(E);
    expect(secondRun.sealed).toBe(1); // only the fresh row
    expect(secondRun.archived).toBe(3); // the recovered batch, not the fresh row's batch

    const keysAfterRecovery = (await E.AUDIT_ARCHIVE.list()).objects.map((o) => o.key).sort();
    expect(keysAfterRecovery).toEqual(keysBeforeRecovery); // no second object written

    const bodyAfter = await (await E.AUDIT_ARCHIVE.get(key1))!.text();
    expect(bodyAfter).toBe(bodyBefore); // identical content, not re-uploaded with the new row folded in

    const recovered = await E.DB.prepare("SELECT archived_at FROM audit_log WHERE id IN (?, ?, ?)")
      .bind(batch1[0]!.id, batch1[1]!.id, batch1[2]!.id)
      .all<{ archived_at: string | null }>();
    for (const r of recovered.results ?? []) expect(r.archived_at).not.toBeNull();

    const freshRow = await E.DB.prepare("SELECT archived_at FROM audit_log WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .first<{ archived_at: string | null }>();
    expect(freshRow!.archived_at).toBeNull(); // its own batch, left for the next run
  });

  // Ruling 25: a sealBatch failure must not skip archiving a backlog left
  // from a previous run. Forces sealBatch's own db.batch(stmts) call to
  // throw by overriding just that one method on the real D1 binding (not a
  // Proxy - D1Database uses private class fields internally, and a Proxy's
  // `this` rebinding on method calls can break those); every other call
  // (lease acquire/release, archivePending's plain .run()/.all()) still goes
  // through the untouched, real methods.
  it("a seal-step failure does not block archiving a backlog from a previous run", async () => {
    // Ruling 24 archives one seal batch per call, and the previous test
    // deliberately leaves its "own, later batch" pending - drain any such
    // pre-existing backlog first so this test's assertions are about ITS OWN
    // single batch, not an artifact of test order.
    for (let guard = 0; guard < 10; guard++) {
      const p = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NOT NULL AND archived_at IS NULL").first<{ n: number }>();
      if (!p!.n) break;
      await runSealer(E);
    }

    await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded" });
    const failingArchive = { head: async () => null, get: async () => null, put: async () => { throw new Error("archive down"); } } as unknown as R2Bucket;
    const seal1 = await runSealer({ DB: E.DB, AUDIT_ARCHIVE: failingArchive }); // seals the row, archive put fails -> backlog of 1
    expect(seal1.sealed).toBe(1);
    expect(seal1.archiveError).toMatch(/archive down/);
    const pendingBefore = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NOT NULL AND archived_at IS NULL").first<{ n: number }>();
    expect(pendingBefore!.n).toBe(1);

    await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded" });
    const realBatch = E.DB.batch.bind(E.DB);
    (E.DB as unknown as { batch: typeof E.DB.batch }).batch = (() => {
      throw new Error("seal batch boom");
    }) as typeof E.DB.batch;
    let res;
    try {
      res = await runSealer({ DB: E.DB, AUDIT_ARCHIVE: E.AUDIT_ARCHIVE });
    } finally {
      (E.DB as unknown as { batch: typeof E.DB.batch }).batch = realBatch;
    }
    expect(res.sealed).toBe(0); // sealBatch threw before sealing the fresh row
    expect(res.archived).toBe(pendingBefore!.n); // archivePending still ran and cleared the backlog

    const stillPending = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NOT NULL AND archived_at IS NULL").first<{ n: number }>();
    expect(stillPending!.n).toBe(0);
  });

  // Ruling 25's headline point: a failure in the unknown-outcome step itself
  // (not just a later sealBatch throw) must not block sealing. The unknown-
  // outcome write is the FIRST db.batch() call a run makes (a system actor
  // has no userId/ip, so write() adds no subject statements before its own
  // insert; the lease uses plain .run(), not .batch()) - sealBatch's own
  // batch is the second call. Fail only the first call, real batch after.
  it("a failure marking a stale started row unknown does not block sealing it", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const startedId = await systemAudit(E.DB, "queue").write({ action: "ai.call", phase: "started", occurredAt: old });

    const realBatch = E.DB.batch.bind(E.DB);
    let calls = 0;
    (E.DB as unknown as { batch: typeof E.DB.batch }).batch = ((...args: Parameters<typeof realBatch>) => {
      calls += 1;
      if (calls === 1) throw new Error("unknown-outcome batch boom");
      return realBatch(...args);
    }) as typeof E.DB.batch;
    let res;
    try {
      res = await runSealer(E);
    } finally {
      (E.DB as unknown as { batch: typeof E.DB.batch }).batch = realBatch;
    }

    expect(res.unknownMarked).toBe(0); // the write failed and was caught, not merely attempted
    const started = await E.DB.prepare("SELECT sealed_at FROM audit_log WHERE id = ?").bind(startedId).first<{ sealed_at: string | null }>();
    expect(started!.sealed_at).not.toBeNull(); // sealed anyway, in the SAME run
    const childYet = await E.DB.prepare("SELECT 1 FROM audit_log WHERE parent_id = ?").bind(startedId).first();
    expect(childYet).toBeNull(); // the unknown-outcome write really did fail, not silently no-op

    await runSealer(E); // a normal run re-attempts the still-childless started row
    const child = await E.DB.prepare("SELECT outcome, phase FROM audit_log WHERE parent_id = ?").bind(startedId).first();
    expect(child).toEqual({ outcome: "unknown", phase: "outcome" });
  });

  // Ruling 22: an entry_hash mismatch at sealing time is a tamper alert, not
  // just a console line. This test runs LAST in the file: it leaves one row
  // permanently unsealed, which would break the seq/tampered assertions in
  // the tests above if it ran earlier (shared per-file D1).
  it("writes exactly one audit.seal.alert for a tampered row, keeps it unsealed, and seals the alert itself later", async () => {
    const victimId = await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { tamper: true } });

    // audit_log_seal_only forbids updating a hashed column directly (by design:
    // it is what makes tampering detectable). Drop the trigger, corrupt the
    // row's reason (a hashed column), then restore the exact same trigger body
    // so the rest of the suite still runs against the real append-only guard.
    const trig = await E.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_log_seal_only'")
      .first<{ sql: string }>();
    expect(trig?.sql).toBeTruthy();
    await E.DB.prepare("DROP TRIGGER audit_log_seal_only").run();
    try {
      await E.DB.prepare("UPDATE audit_log SET reason = 'tampered' WHERE id = ?").bind(victimId).run();
    } finally {
      await E.DB.prepare(trig!.sql).run();
    }

    const first = await runSealer(E);
    expect(first.tampered).toEqual([victimId]);

    // Ruling 23: once the alert exists, sealBatch's own SELECT excludes the
    // row - it is no longer even read, let alone reported as tampered again.
    const second = await runSealer(E);
    expect(second.tampered).toEqual([]);

    const alerts = await E.DB.prepare(
      "SELECT * FROM audit_log WHERE action = 'audit.seal.alert' AND entity_id = ?"
    ).bind(victimId).all<AuditRow>();
    expect(alerts.results ?? []).toHaveLength(1);
    const alert = alerts.results![0]!;
    expect(alert).toMatchObject({
      outcome: "failed",
      reason: "entry_hash mismatch",
      entity_type: "audit_log",
      entity_id: victimId,
    });

    // The victim row itself never seals.
    const victim = await E.DB.prepare("SELECT sealed_at FROM audit_log WHERE id = ?").bind(victimId).first<{ sealed_at: string | null }>();
    expect(victim!.sealed_at).toBeNull();

    // The alert entry is an ordinary, correctly-hashed row: a later run seals
    // and archives it ("check that the alert entry itself gets sealed
    // normally on a later run").
    await runSealer(E);
    const sealedAlert = await E.DB.prepare("SELECT seq, sealed_at, chain_hash, archived_at FROM audit_log WHERE id = ?")
      .bind(alert.id)
      .first<{ seq: number | null; sealed_at: string | null; chain_hash: string | null; archived_at: string | null }>();
    expect(sealedAlert!.seq).not.toBeNull();
    expect(sealedAlert!.sealed_at).not.toBeNull();
    expect(sealedAlert!.chain_hash).not.toBeNull();
    expect(sealedAlert!.archived_at).not.toBeNull();

    // Skipping the tampered row must never break the chain for everything
    // sealed around it: every sealed row (this file's whole database, since
    // expired_through_seq is 0) still forms one unbroken GENESIS-rooted
    // sequence, the victim never joined it, and the alert did.
    const all = await rows();
    expect(all.map((r) => r.seq)).toEqual(all.map((_, i) => i + 1));
    let chain = GENESIS;
    for (const r of all) {
      chain = await chainHash(chain, r.entry_hash);
      expect(r.chain_hash, `row ${r.id} chain_hash`).toBe(chain);
    }
    expect(all.map((r) => r.id)).not.toContain(victimId);
    expect(all.map((r) => r.id)).toContain(alert.id);
  });
});
