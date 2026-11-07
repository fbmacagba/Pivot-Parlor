import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { systemAudit } from "../src/audit/context";
import { runSealer } from "../src/audit/sealer";
import { runAuditNightly } from "../src/audit/nightly";

// Ruling 57: the emails are the out-of-band copy, so their delivery must
// itself be on record. After the sends the nightly writes an audit.anchor
// entry with each send's outcome (err.name only, never the message), and a
// failed send becomes a problem line on the NEXT night. Own file (own D1):
// the tests run as consecutive nights.

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket; RESEND_API_KEY?: string };

function withEnv() {
  return { ...E, RESEND_API_KEY: "re_test", AUDIT_OPERATOR_EMAIL: "owner@test.local" };
}

async function sealedTrail(n: number) {
  for (let i = 0; i < n; i++) await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { i } });
  for (let i = 0; i < 5; i++) {
    const r = await runSealer(E);
    if (!r.sealed && !r.archived) break;
  }
}

async function latestAnchorEntry() {
  return E.DB.prepare(
    "SELECT outcome, reason, details_json FROM audit_log WHERE action = 'audit.anchor' ORDER BY occurred_at DESC, id DESC LIMIT 1"
  ).first<{ outcome: string; reason: string | null; details_json: string }>();
}

async function latestVerifyEntry() {
  return E.DB.prepare(
    "SELECT outcome, reason FROM audit_log WHERE action = 'audit.verify' AND details_json LIKE '%checked%' ORDER BY occurred_at DESC LIMIT 1"
  ).first<{ outcome: string; reason: string | null }>();
}

type SendRecord = { outcome: "succeeded" | "failed"; error?: string; date?: string } | null;

describe("audit.anchor delivery record (Ruling 57)", () => {
  // Tomorrow's clock, so yesterday's anchor (today) is written and emailed.
  const tomorrow = new Date(Date.now() + 24 * 3600_000);

  it("records a succeeded audit.anchor entry after the anchor email is sent", async () => {
    await sealedTrail(2);
    const sent: string[] = [];
    await runAuditNightly(withEnv(), tomorrow, async (_k, _to, subject) => { sent.push(subject); });

    expect(sent.some((s) => /anchor/i.test(s))).toBe(true);
    const entry = await latestAnchorEntry();
    expect(entry, "no audit.anchor entry written").not.toBeNull();
    expect(entry!.outcome).toBe("succeeded");
    const d = JSON.parse(entry!.details_json) as { alert: SendRecord; anchor: SendRecord };
    expect(d.anchor).toMatchObject({ outcome: "succeeded" });
  });

  it("records a failed send with the error's name only, never its message", async () => {
    const send = async (_k: string, _to: string, subject: string) => {
      if (/anchor/i.test(subject)) throw new TypeError("secret-detail-from-the-vendor");
    };
    await runAuditNightly(withEnv(), tomorrow, send);

    const entry = await latestAnchorEntry();
    expect(entry!.outcome).toBe("failed");
    const d = JSON.parse(entry!.details_json) as { alert: SendRecord; anchor: SendRecord };
    expect(d.anchor).toEqual(expect.objectContaining({ outcome: "failed", error: "TypeError" }));
    expect(entry!.details_json).not.toContain("secret-detail");
    expect(entry!.reason ?? "").not.toContain("secret-detail");
  });

  it("raises the previous night's failed send as a problem line the next night, once", async () => {
    const sent: { subject: string; lines: string[] }[] = [];
    await runAuditNightly(withEnv(), tomorrow, async (_k, _to, subject, lines) => { sent.push({ subject, lines }); });

    const verify = await latestVerifyEntry();
    expect(verify!.outcome).toBe("failed");
    expect(verify!.reason).toMatch(/previous night's anchor email could not be sent \(TypeError\)/);
    const alert = sent.find((m) => /needs attention/i.test(m.subject));
    expect(alert?.lines.some((l) => /previous night's anchor email could not be sent/.test(l))).toBe(true);

    // Tonight's sends succeeded, so the night after is clean of that line.
    await runAuditNightly(withEnv(), tomorrow, async () => {});
    expect((await latestVerifyEntry())!.reason ?? "").not.toMatch(/previous night's/);
  });
});
