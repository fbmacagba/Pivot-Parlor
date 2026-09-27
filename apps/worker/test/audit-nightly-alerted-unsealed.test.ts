import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { systemAudit } from "../src/audit/context";
import { runSealer } from "../src/audit/sealer";
import { runAuditNightly } from "../src/audit/nightly";

// Ruling 56: the Ruling 27 line ("N entries failed their integrity check when
// sealing") only counts audit.seal.alert entries from the last 24 hours, and
// the tampered row itself is excluded from the "unsealed" count. Without a
// timestamp-free line, a tamper alarms for one night and then reads green
// forever. Own file (own D1): it permanently leaves a tampered, unsealed row.

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket; RESEND_API_KEY?: string };

function withEnv() {
  return { ...E, RESEND_API_KEY: "re_test", AUDIT_OPERATOR_EMAIL: "owner@test.local" };
}

async function drainSealer(now?: Date) {
  for (let i = 0; i < 5; i++) {
    const r = await runSealer(E, now);
    if (!r.sealed && !r.archived) break;
  }
}

describe("permanently unsealed after an integrity failure (Ruling 56)", () => {
  it("keeps reporting a tampered, alerted row after its alert is more than 24 hours old", async () => {
    const id = await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded" });
    await E.DB.prepare("DROP TRIGGER IF EXISTS audit_log_seal_only").run();
    await E.DB.prepare("UPDATE audit_log SET reason = 'forged' WHERE id = ?").bind(id).run();
    const seal = await runSealer(E);
    expect(seal.tampered).toContain(id);
    await drainSealer(); // seal + archive the alert entry itself

    // Two days later: the alert has left the 24 h window.
    const later = new Date(Date.now() + 2 * 24 * 3600_000);
    const sent: { subject: string; lines: string[] }[] = [];
    await runAuditNightly(withEnv(), later, async (_k, _to, subject, lines) => { sent.push({ subject, lines }); });

    const entry = await E.DB.prepare(
      "SELECT outcome, reason, details_json FROM audit_log WHERE action = 'audit.verify' AND details_json LIKE '%checked%' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ outcome: string; reason: string | null; details_json: string }>();
    const details = JSON.parse(entry!.details_json) as { sealAlerts: number; unsealed: number; alertedUnsealed: number };
    expect(details.sealAlerts).toBe(0); // the 24 h line has gone quiet
    expect(details.unsealed).toBe(0);
    expect(details.alertedUnsealed).toBe(1);
    expect(entry!.outcome).toBe("failed");
    expect(entry!.reason).toMatch(/1 entries are permanently unsealed after failing their integrity check/);
    expect(sent.some((m) => /needs attention/i.test(m.subject) && m.lines.some((l) => /permanently unsealed/.test(l)))).toBe(true);
  });
});
