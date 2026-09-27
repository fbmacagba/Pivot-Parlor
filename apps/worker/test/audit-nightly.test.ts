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
// "succeeded", for a reason unrelated to what this file tests. See the task
// report for the reproduction and the two adaptations considered.

async function sealedTrail(n: number) {
  for (let i = 0; i < n; i++) await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { i } });
  await runSealer(E);
  const max = await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>();
  return max!.m;
}

async function dropTriggers() {
  await E.DB.prepare("DROP TRIGGER IF EXISTS audit_log_seal_only").run();
}

describe("runAuditNightly", () => {
  it("records an audit.verify entry and emails the anchor", async () => {
    await E.DB.prepare("INSERT OR IGNORE INTO platform_users (id, name, email, password_hash, role) VALUES ('dev-n', 'Dev', 'dev@test.local', 'x', 'developer')").run();
    await sealedTrail(2);
    const sent: { subject: string; lines: string[] }[] = [];
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    await runAuditNightly({ ...E, RESEND_API_KEY: "re_test" }, tomorrow, async (_k, _to, subject, lines) => { sent.push({ subject, lines }); });
    const entry = await E.DB.prepare("SELECT outcome, details_json FROM audit_log WHERE action = 'audit.verify' AND via = 'cron' AND details_json LIKE '%checked%' ORDER BY occurred_at DESC LIMIT 1").first<{ outcome: string; details_json: string }>();
    expect(entry!.outcome).toBe("succeeded");
    expect(sent.some((m) => /anchor/i.test(m.subject))).toBe(true);
    const anchorKey = `anchors/${new Date().toISOString().slice(0, 10)}.json`;
    expect(await E.AUDIT_ARCHIVE.head(anchorKey)).not.toBeNull();
  });

  // Ruling 27: the nightly's "unsealed" count excludes rows that already
  // carry an audit.seal.alert (the sealer will never advance them past
  // "unsealed" — Ruling 23 — so counting them as a growing unsealed backlog
  // every night forever would be noise, not signal). They are instead
  // reported through a dedicated integrity-failure line and detail count.
  it("excludes a tampered, alerted row from the unsealed count and reports it as an integrity failure", async () => {
    await E.DB.prepare("INSERT OR IGNORE INTO platform_users (id, name, email, password_hash, role) VALUES ('dev-n', 'Dev', 'dev@test.local', 'x', 'developer')").run();
    const elevenMinAgo = new Date(Date.now() - 11 * 60_000).toISOString();
    const id = await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", occurredAt: elevenMinAgo });
    await dropTriggers();
    await E.DB.prepare("UPDATE audit_log SET reason = 'forged' WHERE id = ?").bind(id).run();
    // The sealer sees the entry_hash mismatch, never seals this row, and
    // writes it its one audit.seal.alert (Ruling 22/23) instead.
    const sealResult = await runSealer(E);
    expect(sealResult.tampered).toContain(id);

    const sent: { subject: string; lines: string[] }[] = [];
    await runAuditNightly({ ...E, RESEND_API_KEY: "re_test" }, new Date(), async (_k, _to, subject, lines) => { sent.push({ subject, lines }); });

    const entry = await E.DB.prepare("SELECT outcome, reason, details_json FROM audit_log WHERE action = 'audit.verify' AND via = 'cron' AND details_json LIKE '%checked%' ORDER BY occurred_at DESC LIMIT 1").first<{ outcome: string; reason: string; details_json: string }>();
    const details = JSON.parse(entry!.details_json) as { unsealed: number; sealAlerts: number };
    expect(details.unsealed).toBe(0);
    expect(details.sealAlerts).toBe(1);
    expect(entry!.reason).toMatch(/1 entries failed their integrity check when sealing/);
    expect(sent.some((m) => /needs attention/i.test(m.subject) && m.lines.some((l) => /failed their integrity check when sealing/.test(l)))).toBe(true);
  });
});
