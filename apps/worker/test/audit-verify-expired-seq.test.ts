import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { systemAudit } from "../src/audit/context";
import { runSealer } from "../src/audit/sealer";
import { verifyRange } from "../src/audit/verify";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

// A separate file (own vitest-pool-workers D1), for the same reason Task 8's
// audit-sealer-expired-seq.test.ts is separate: audit_seal_state.
// expired_through_seq/expired_chain_hash only matters as a CHAIN CONTINUATION
// SEED when no sealed row physically exists at or below that seq — a
// condition only a genuinely empty audit_log can provide without deleting
// real rows (blocked by audit_log_no_delete for anything under 6 years old).

describe("verifyRange - expired_through_seq / expired_chain_hash continuation", () => {
  it("continues the chain from the configured expired_chain_hash when nothing is sealed below it", async () => {
    const pre = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE seq IS NOT NULL").first<{ n: number }>();
    expect(pre!.n).toBe(0);

    const expiredChainHash = "f".repeat(64);
    await E.DB.prepare("UPDATE audit_seal_state SET expired_through_seq = 500, expired_chain_hash = ? WHERE id = 1")
      .bind(expiredChainHash).run();

    // The sealer itself falls back to expired_through_seq/expired_chain_hash
    // when audit_log has no sealed rows yet (Task 8), so this row lands at
    // seq 501, chained from expiredChainHash rather than GENESIS.
    await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded" });
    await runSealer(E);

    const row = await E.DB.prepare("SELECT seq FROM audit_log WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1").first<{ seq: number }>();
    expect(row!.seq).toBe(501);

    const result = await verifyRange(E.DB, E.AUDIT_ARCHIVE, 501, 501);
    expect(result).toMatchObject({ ok: true, checked: 1 });
  });

  it("still fails fast when the range starts past an expiry boundary that does not match", async () => {
    // expired_through_seq is 500 (from the previous test); asking to start
    // at 1000 has no row at 999 and no matching expiry boundary either.
    const result = await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1000, 1000);
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/no chain value before seq/);
  });
});
