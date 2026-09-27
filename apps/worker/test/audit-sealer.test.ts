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

  it("marks a started entry with no outcome after 15 minutes as unknown", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const startedId = await systemAudit(E.DB, "queue").write({ action: "ai.call", phase: "started", occurredAt: old });
    await runSealer(E);
    const child = await E.DB.prepare("SELECT outcome, phase FROM audit_log WHERE parent_id = ?").bind(startedId).first();
    expect(child).toEqual({ outcome: "unknown", phase: "outcome" });
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

    const second = await runSealer(E);
    expect(second.tampered).toEqual([victimId]); // still tampered every run - proves dedupe, not "never re-seen"

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
