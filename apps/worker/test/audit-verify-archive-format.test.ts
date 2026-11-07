import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { systemAudit } from "../src/audit/context";
import { runSealer } from "../src/audit/sealer";
import { verifyRange } from "../src/audit/verify";

// Ruling 58: archive lines are built from a fixed, versioned column list and
// verify compares on the same list, so a future ADD COLUMN on audit_log
// cannot break the comparison against objects already in the locked bucket.
// Own file (own D1): it alters audit_log and rewrites an archive object.

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

async function sealOne() {
  await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded" });
  for (let i = 0; i < 5; i++) {
    const r = await runSealer(E);
    if (!r.sealed && !r.archived) break;
  }
  return E.DB.prepare("SELECT seq, archive_key FROM audit_log WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1")
    .first<{ seq: number; archive_key: string }>();
}

async function rewriteLine(key: string, edit: (line: Record<string, unknown>) => void) {
  const text = await (await E.AUDIT_ARCHIVE.get(key))!.text();
  const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  lines.forEach(edit);
  await E.AUDIT_ARCHIVE.put(key, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("versioned archive lines (Ruling 58)", () => {
  it("still verifies archived rows after a column is added to audit_log", async () => {
    const r = await sealOne();
    expect((await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1, r!.seq, { requireArchived: true })).ok).toBe(true);

    await E.DB.prepare("ALTER TABLE audit_log ADD COLUMN added_later TEXT").run();
    const after = await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1, r!.seq, { requireArchived: true });
    expect(after, JSON.stringify(after)).toMatchObject({ ok: true });
  });

  it("fails a row whose archived line carries an unknown or missing format", async () => {
    const r = await sealOne();
    await rewriteLine(r!.archive_key, (l) => { l.archive_format = 99; });
    const unknown = await verifyRange(E.DB, E.AUDIT_ARCHIVE, r!.seq, r!.seq);
    expect(unknown).toMatchObject({ ok: false, firstBadSeq: r!.seq });
    expect(unknown.problem).toMatch(/unknown archive format/);

    await rewriteLine(r!.archive_key, (l) => { delete l.archive_format; });
    const missing = await verifyRange(E.DB, E.AUDIT_ARCHIVE, r!.seq, r!.seq);
    expect(missing).toMatchObject({ ok: false, firstBadSeq: r!.seq });
    expect(missing.problem).toMatch(/unknown archive format/);
  });
});
