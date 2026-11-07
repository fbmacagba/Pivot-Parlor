import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuditRecorder } from "@repo/audit";
import { runSealer } from "../src/audit/sealer";
import { verifyRange } from "../src/audit/verify";
import { redactDueSubjects } from "../src/audit/retention";
import { seedUser } from "./helpers";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

describe("audit retention", () => {
  it("blanks due personal details (user and shop subjects alike) and the chain still verifies", async () => {
    const userId = await seedUser("admin", null);
    await createAuditRecorder({ db: E.DB, worker: "t", via: "api", actor: { type: "admin", userId, role: "admin", ip: "192.0.2.44" }, requestId: null })
      .write({ action: "site.pause", outcome: "succeeded" });
    await runSealer(E);
    await E.DB.prepare("UPDATE audit_subjects SET redact_after = ? WHERE user_id = ?").bind(new Date(Date.now() - 1000).toISOString(), userId).run();

    // A 'shop' subject (Task 6): no email/ip, display_name "<name> (<slug>)".
    const shopSubjectId = `subj_shop_${crypto.randomUUID()}`;
    await E.DB.prepare(
      "INSERT INTO audit_subjects (id, kind, shop_id, display_name, created_at, redact_after) VALUES (?, 'shop', ?, ?, ?, ?)"
    )
      .bind(shopSubjectId, crypto.randomUUID(), "Deleted Shop (deleted-shop)", new Date().toISOString(), new Date(Date.now() - 1000).toISOString())
      .run();

    expect(await redactDueSubjects(E.DB, new Date(), 500)).toBe(2);

    const s = await E.DB.prepare("SELECT display_name, email, ip, redacted_at FROM audit_subjects WHERE user_id = ?").bind(userId).first();
    expect(s).toMatchObject({ display_name: null, email: null, ip: null });

    const shopSubj = await E.DB.prepare("SELECT display_name, email, ip, redacted_at FROM audit_subjects WHERE id = ?").bind(shopSubjectId).first();
    expect(shopSubj).toMatchObject({ display_name: null, email: null, ip: null });
    expect((shopSubj as { redacted_at: string | null }).redacted_at).not.toBeNull();

    const max = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;
    await runSealer(E);
    const max2 = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;
    expect((await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1, max2)).ok).toBe(true);
    expect(max2).toBeGreaterThan(max); // the subject.redact entry itself was sealed
  });

  it("does not re-blank or re-audit a subject once already redacted", async () => {
    const userId = await seedUser("admin", null);
    await createAuditRecorder({ db: E.DB, worker: "t", via: "api", actor: { type: "admin", userId, role: "admin", ip: "203.0.113.9" }, requestId: null })
      .write({ action: "site.pause", outcome: "succeeded" });
    await runSealer(E);
    await E.DB.prepare("UPDATE audit_subjects SET redact_after = ? WHERE user_id = ?").bind(new Date(Date.now() - 1000).toISOString(), userId).run();

    expect(await redactDueSubjects(E.DB, new Date(), 500)).toBeGreaterThan(0);
    expect(await redactDueSubjects(E.DB, new Date(), 500)).toBe(0);
  });
});

// expireOldEntries is exercised end to end (with the last_verified_seq gate,
// Ruling 38) in audit-retention-expiry.test.ts, in its own file so the old
// row is the very first entry ever sealed and therefore an expirable prefix.
