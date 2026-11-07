import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chainHash, entryHash, GENESIS, type AuditRow } from "@repo/audit";
import { systemAudit } from "../src/audit/context";
import { runSealer } from "../src/audit/sealer";
import { verifyRange } from "../src/audit/verify";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket; RESEND_API_KEY?: string };

async function sealedTrail(n: number) {
  for (let i = 0; i < n; i++) await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { i } });
  await runSealer(E);
  const max = await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>();
  return max!.m;
}

async function dropTriggers() {
  await E.DB.prepare("DROP TRIGGER IF EXISTS audit_log_seal_only").run();
}

describe("verifyRange", () => {
  it("passes on an untouched trail", async () => {
    const max = await sealedTrail(4);
    expect(await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1, max)).toMatchObject({ ok: true, checked: max });
  });

  it("catches a naive edit at the edited seq", async () => {
    const max = await sealedTrail(3);
    await dropTriggers(); // an attacker with database access
    await E.DB.prepare("UPDATE audit_log SET reason = 'forged' WHERE seq = 2").run();
    const r = await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1, max);
    expect(r).toMatchObject({ ok: false, firstBadSeq: 2 });
    expect(r.problem).toMatch(/entry_hash/);
  });

  it("catches an edit that recomputes every later hash, via the archive", async () => {
    const max = await sealedTrail(3);
    await dropTriggers();
    const rows = (await E.DB.prepare("SELECT * FROM audit_log WHERE seq IS NOT NULL ORDER BY seq").all<AuditRow>()).results!;
    let prev = rows[0]!.seq === 1 ? GENESIS : rows[0]!.chain_hash!;
    for (const r of rows) {
      const forged = r.seq === 2 ? { ...r, reason: "forged" } : r;
      const eh = await entryHash(forged);
      prev = await chainHash(prev, eh);
      await E.DB.prepare("UPDATE audit_log SET reason = ?, entry_hash = ?, chain_hash = ? WHERE id = ?")
        .bind(forged.reason, eh, prev, r.id).run();
    }
    const res = await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1, max);
    expect(res.ok).toBe(false);
    expect(res.problem).toMatch(/archive/);
  });

  // The three tests above permanently corrupt seq 1-10 (see audit-nightly.test.ts's
  // header comment for why runAuditNightly's own tests live in a separate
  // file). Everything below seals FRESH rows past that point and never
  // touches seq <= 10 — seeding the chain from row 10's already
  // self-consistent (if archive-mismatched) chain_hash is exactly what
  // production does when it resumes past a known-bad row (Ruling 31).

  it("fails at an interior gap when a seq goes missing", async () => {
    const max = await sealedTrail(3);
    const gapSeq = max - 1;
    await dropTriggers(); // idempotent; may already be dropped by an earlier test
    await E.DB.prepare("UPDATE audit_log SET seq = NULL WHERE seq = ?").bind(gapSeq).run();
    const r = await verifyRange(E.DB, E.AUDIT_ARCHIVE, max - 2, max);
    expect(r.ok).toBe(false);
    expect(r.firstBadSeq).toBe(gapSeq);
    expect(r.problem).toMatch(/missing seq/);
  });

  it("passes a NULL archive_key by default but fails it under requireArchived (Ruling 28)", async () => {
    const max = await sealedTrail(2);
    await dropTriggers(); // idempotent; may already be dropped by an earlier test
    await E.DB.prepare("UPDATE audit_log SET archive_key = NULL WHERE seq = ?").bind(max).run();
    const withoutFlag = await verifyRange(E.DB, E.AUDIT_ARCHIVE, max, max);
    expect(withoutFlag.ok).toBe(true);
    const withFlag = await verifyRange(E.DB, E.AUDIT_ARCHIVE, max, max, { requireArchived: true });
    expect(withFlag.ok).toBe(false);
    expect(withFlag.firstBadSeq).toBe(max);
    expect(withFlag.problem).toMatch(/not archived/);
  });

  it("fails a row whose archive object was removed from R2", async () => {
    const max = await sealedTrail(2);
    const row = await E.DB.prepare("SELECT archive_key FROM audit_log WHERE seq = ?").bind(max).first<{ archive_key: string }>();
    await E.AUDIT_ARCHIVE.delete(row!.archive_key);
    const r = await verifyRange(E.DB, E.AUDIT_ARCHIVE, max, max);
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/missing from archive/);
  });

  // Ruling 30: an unparsable archive line must not throw; it fails only the
  // row whose own copy is corrupt, not every row that shares the object.
  it("fails only the row behind a corrupt archive line, without throwing", async () => {
    const max = await sealedTrail(2);
    const rows = (await E.DB.prepare("SELECT seq, archive_key FROM audit_log WHERE seq IN (?, ?)").bind(max - 1, max).all<{ seq: number; archive_key: string }>()).results!;
    expect(rows[0]!.archive_key).toBe(rows[1]!.archive_key); // one seal batch, one archive object (Ruling 24)
    const key = rows[0]!.archive_key;
    const obj = await E.AUDIT_ARCHIVE.get(key);
    const lines = (await obj!.text()).split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    lines[1] = "{garbage";
    await E.AUDIT_ARCHIVE.put(key, lines.join("\n") + "\n");

    const r = await verifyRange(E.DB, E.AUDIT_ARCHIVE, max - 1, max);
    expect(r).toMatchObject({ ok: false, firstBadSeq: max, checked: 1 });
    expect(r.problem).toMatch(/missing from archive/);
  });

  it("returns ok:false for an invalid range instead of scanning", async () => {
    expect((await verifyRange(E.DB, E.AUDIT_ARCHIVE, 0, 5)).ok).toBe(false);
    expect((await verifyRange(E.DB, E.AUDIT_ARCHIVE, 10, 5)).ok).toBe(false);
  });
});
