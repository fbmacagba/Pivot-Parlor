import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { systemAudit } from "../src/audit/context";
import { runSealer } from "../src/audit/sealer";
import { verifyRange } from "../src/audit/verify";
import { NIGHTLY_ARCHIVE_OBJECTS, runAuditNightly } from "../src/audit/nightly";

// Ruling 54: a Worker invocation has a subrequest ceiling (Workers Paid
// default 10,000), and every distinct archive object verifyRange reads is one
// R2 GET. At low traffic the sealer produces up to one seal batch (= one
// archive object) per minute, so the nightly's 20k-row walk would need far
// more GETs than the ceiling allows within weeks and then fail every night.
// These tests build many single-row seal batches (one object each) and run
// with a LOWERED budget through the exported seam, rather than literally
// building thousands of objects.
//
// Own file (own vitest-pool-workers D1): the assertions reason about exact
// seq numbers 1..N.

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket; RESEND_API_KEY?: string };
const OWNER_EMAIL = "owner@test.local";

function withEnv(overrides: Record<string, unknown> = {}) {
  return { ...E, RESEND_API_KEY: "re_test", AUDIT_OPERATOR_EMAIL: OWNER_EMAIL, ...overrides };
}

/** One row per seal batch, each with its own distinct sealed_at (an explicit
 *  clock per sealer run: two runs in the same millisecond would share a
 *  sealed_at and be archived as one object). */
async function singleRowBatches(n: number, base = Date.now()) {
  for (let i = 0; i < n; i++) {
    await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { i } });
    await runSealer(E, new Date(base + i * 1000));
  }
  // Drain anything left sealed-but-unarchived.
  for (let i = 0; i < 10; i++) {
    const r = await runSealer(E, new Date(base + (n + i) * 1000));
    if (!r.sealed && !r.archived) break;
  }
  return (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;
}

/** A plain object delegating to the real binding (not a Proxy: bindings use
 *  private class fields), recording every archive-object GET. Anchor GETs
 *  (anchors/...) are the anchor step's own reads, not archive objects. */
function countingBucket() {
  const archiveGets: string[] = [];
  const bucket = {
    get: (key: string) => {
      if (!key.startsWith("anchors/")) archiveGets.push(key);
      return E.AUDIT_ARCHIVE.get(key);
    },
    head: (key: string) => E.AUDIT_ARCHIVE.head(key),
    put: (key: string, value: string, opts?: R2PutOptions) => E.AUDIT_ARCHIVE.put(key, value, opts),
    list: (opts?: R2ListOptions) => E.AUDIT_ARCHIVE.list(opts),
    delete: (key: string) => E.AUDIT_ARCHIVE.delete(key),
  } as unknown as R2Bucket;
  return { bucket, archiveGets };
}

async function latestVerifyEntry() {
  return E.DB.prepare(
    "SELECT outcome, reason, details_json FROM audit_log WHERE action = 'audit.verify' AND via = 'cron' AND details_json LIKE '%checked%' ORDER BY occurred_at DESC LIMIT 1"
  ).first<{ outcome: string; reason: string | null; details_json: string }>();
}

async function sealState() {
  return E.DB.prepare("SELECT last_verified_seq, walk_cursor_seq FROM audit_seal_state WHERE id = 1")
    .first<{ last_verified_seq: number; walk_cursor_seq: number }>();
}

type RangeDetails = { from: number; to: number; ok: boolean; firstBadSeq: number | null; capped: boolean } | null;

describe("archive-object budget (Ruling 54)", () => {
  it("the production nightly budget is 2,000 archive objects", () => {
    expect(NIGHTLY_ARCHIVE_OBJECTS).toBe(2000);
  });

  it("verifyRange stops cleanly after maxArchiveObjects distinct objects and reports the last fully verified seq", async () => {
    const max = await singleRowBatches(8);
    expect(max).toBe(8);
    const keys = await E.DB.prepare("SELECT COUNT(DISTINCT archive_key) AS n FROM audit_log WHERE seq BETWEEN 1 AND 8").first<{ n: number }>();
    expect(keys!.n, "fixture must be one archive object per row").toBe(8);

    const { bucket, archiveGets } = countingBucket();
    const r = await verifyRange(E.DB, bucket, 1, 8, { requireArchived: true, maxArchiveObjects: 3 });
    expect(r).toMatchObject({ ok: true, fromSeq: 1, toSeq: 3, checked: 3, firstBadSeq: null, capped: true, archiveObjects: 3 });
    expect(archiveGets.length).toBe(3);

    // Uncapped (default) still covers the whole range.
    const full = await verifyRange(E.DB, E.AUDIT_ARCHIVE, 1, 8, { requireArchived: true });
    expect(full).toMatchObject({ ok: true, toSeq: 8, checked: 8, capped: false, archiveObjects: 8 });
  });

  it("the nightly reads at most the budget in archive objects across both ranges, advances the cursor to the last verified seq, and still records and emails", async () => {
    // 30 single-row batches in total (8 from the test above + 22 more).
    const clock = new Date();
    const max = await singleRowBatches(22, clock.getTime() + 60_000);
    expect(max).toBe(30);
    const tomorrow = new Date(clock.getTime() + 24 * 3600_000); // so an anchor is written and emailed

    const { bucket, archiveGets } = countingBucket();
    const sent: string[] = [];
    await runAuditNightly(withEnv({ AUDIT_ARCHIVE: bucket }), tomorrow, async (_k, _to, subject) => { sent.push(subject); }, { archiveObjects: 10 });

    expect(archiveGets.length, `archive GETs: ${archiveGets.join(",")}`).toBeLessThanOrEqual(10);
    const entry = await latestVerifyEntry();
    expect(entry, "audit.verify entry must still be written").not.toBeNull();
    const details = JSON.parse(entry!.details_json) as { incremental: RangeDetails; walk: RangeDetails };
    expect(details.incremental).toMatchObject({ from: 1, to: 10, ok: true, capped: true });
    expect(details.walk).toBeNull(); // incremental spent the whole budget
    expect(sent.some((s) => /anchor/i.test(s)), `sent: ${sent.join(" | ")}`).toBe(true);

    const state = await sealState();
    expect(state!.last_verified_seq).toBe(10); // the capped range's last fully verified seq
    expect(state!.walk_cursor_seq).toBe(0); // walk did not run, cursor untouched
  });

  it("gives the walk whatever budget the incremental range left over", async () => {
    // Next night: incremental covers 11..30 (20 objects), walk gets 5 of a 25 budget.
    const { bucket, archiveGets } = countingBucket();
    await runAuditNightly(withEnv({ AUDIT_ARCHIVE: bucket }), new Date(), async () => {}, { archiveObjects: 25 });

    expect(archiveGets.length).toBeLessThanOrEqual(25);
    const details = JSON.parse((await latestVerifyEntry())!.details_json) as { incremental: RangeDetails; walk: RangeDetails };
    expect(details.incremental).toMatchObject({ from: 11, ok: true, capped: false });
    expect(details.walk).toMatchObject({ from: 1, to: 5, ok: true, capped: true });
    const state = await sealState();
    expect(state!.walk_cursor_seq).toBe(5);
  });
});
