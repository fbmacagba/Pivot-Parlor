import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chainHash, type AuditRow } from "@repo/audit";
import { runSealer } from "../src/audit/sealer";
import { systemAudit } from "../src/audit/context";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

// Minor (c): sealBatch's fallback (`state?.expired_through_seq`,
// `state?.expired_chain_hash`) must be exercised by a genuinely empty
// audit_log, not just its default zero/NULL values (which the main
// "seals in order, chains from GENESIS" test in audit-sealer.test.ts already
// covers implicitly). This needs a file of its own: vitest-pool-workers
// isolates simulated D1/KV/R2 per TEST FILE, not per test - every other
// sealer test shares one growing table, so audit_log can never be empty
// again once any test has sealed a row into it.
describe("sealer: seq continuation from audit_seal_state", () => {
  it("chains from audit_seal_state.expired_through_seq/expired_chain_hash when no sealed rows remain", async () => {
    const noneSealed = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE seq IS NOT NULL").first<{ n: number }>();
    expect(noneSealed!.n).toBe(0); // precondition: this really is the "no sealed rows remain" case

    const priorChain = await chainHash("GENESIS", "f".repeat(64));
    await E.DB.prepare("UPDATE audit_seal_state SET expired_through_seq = ?, expired_chain_hash = ? WHERE id = 1")
      .bind(500, priorChain)
      .run();

    await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded" });
    const res = await runSealer(E);
    expect(res.sealed).toBe(1);

    const sealedRow = await E.DB
      .prepare("SELECT seq, chain_hash, entry_hash FROM audit_log WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .first<{ seq: number; chain_hash: string; entry_hash: string }>();
    expect(sealedRow!.seq).toBe(501); // continues from expired_through_seq, not from 0
    expect(sealedRow!.chain_hash).toBe(await chainHash(priorChain, sealedRow!.entry_hash)); // continues from expired_chain_hash, not from GENESIS
  });
});
