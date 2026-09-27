import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chainHash, entryHash, type AuditRow } from "@repo/audit";
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
    let prev = rows[0]!.seq === 1 ? "GENESIS" : rows[0]!.chain_hash!;
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
});
