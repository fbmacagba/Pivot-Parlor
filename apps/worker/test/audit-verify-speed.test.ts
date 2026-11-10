import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { systemAudit } from "../src/audit/context";
import { runSealer } from "../src/audit/sealer";
import { ARCHIVE_FETCH_CONCURRENCY, verifyRange } from "../src/audit/verify";
import { MANUAL_VERIFY_ARCHIVE_OBJECTS } from "../src/routes/audit";
import { authHeaders, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";

// "Check now" on staging took 5.6s on 2026-11-07 and over 10.5s on 2026-11-10:
// verifyRange read every archive object one after another, and the manual
// check had no cap, so it slowed as the trail grew. These tests pin parallel
// reads, an unchanged budget, an unchanged failure, and the manual cap.
//
// Own file (own vitest-pool-workers D1). Rows persist across this file's
// tests, so every range is taken from MAX(seq) before and after seeding.

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

const maxSeq = async () => (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number | null }>())?.m ?? 0;

/** One row per seal batch, so one archive object per row (each sealer run has
 *  its own clock: two runs in one millisecond would share an object). */
async function singleRowBatches(n: number, base = Date.now()): Promise<{ from: number; to: number }> {
  const from = (await maxSeq()) + 1;
  for (let i = 0; i < n; i++) {
    await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { i } });
    await runSealer(E, new Date(base + i * 1000));
  }
  for (let i = 0; i < 10; i++) {
    const r = await runSealer(E, new Date(base + (n + i) * 1000));
    if (!r.sealed && !r.archived) break;
  }
  const to = await maxSeq();
  const keys = await E.DB.prepare("SELECT COUNT(DISTINCT archive_key) AS n FROM audit_log WHERE seq BETWEEN ? AND ?")
    .bind(from, to)
    .first<{ n: number }>();
  expect(keys!.n, "fixture must be one archive object per row").toBe(to - from + 1);
  return { from, to };
}

/** Delegates to the real binding (a plain object: bindings use private class
 *  fields), holding each archive GET open briefly and recording how many were
 *  open at once. `fails` makes one key's GET reject. */
function slowBucket(fails?: (key: string) => boolean) {
  let open = 0;
  let maxOpen = 0;
  const gets: string[] = [];
  const bucket = {
    get: async (key: string) => {
      gets.push(key);
      open++;
      maxOpen = Math.max(maxOpen, open);
      try {
        await new Promise((r) => setTimeout(r, 15));
        if (fails?.(key)) throw new Error("r2 down");
        return await E.AUDIT_ARCHIVE.get(key);
      } finally {
        open--;
      }
    },
    head: (key: string) => E.AUDIT_ARCHIVE.head(key),
    put: (key: string, value: string, opts?: R2PutOptions) => E.AUDIT_ARCHIVE.put(key, value, opts),
    list: (opts?: R2ListOptions) => E.AUDIT_ARCHIVE.list(opts),
    delete: (key: string) => E.AUDIT_ARCHIVE.delete(key),
  } as unknown as R2Bucket;
  return { bucket, gets, maxOpen: () => maxOpen };
}

describe("verifyRange reads archive objects in parallel", () => {
  it("reads several at once, never more than ARCHIVE_FETCH_CONCURRENCY, and each only once", async () => {
    expect(ARCHIVE_FETCH_CONCURRENCY).toBe(6);
    const { from, to } = await singleRowBatches(14);
    const s = slowBucket();
    const r = await verifyRange(E.DB, s.bucket, from, to);
    expect(r).toMatchObject({ ok: true, fromSeq: from, toSeq: to, checked: to - from + 1, capped: false, archiveObjects: to - from + 1 });
    expect(s.maxOpen(), "archive objects were read one at a time").toBeGreaterThan(1);
    expect(s.maxOpen()).toBeLessThanOrEqual(ARCHIVE_FETCH_CONCURRENCY);
    expect(new Set(s.gets).size).toBe(s.gets.length);
  });

  it("a capped check still reads no more objects than its budget", async () => {
    const { from, to } = await singleRowBatches(10);
    const s = slowBucket();
    const r = await verifyRange(E.DB, s.bucket, from, to, { maxArchiveObjects: 4 });
    expect(r).toMatchObject({ ok: true, fromSeq: from, toSeq: from + 3, checked: 4, capped: true, archiveObjects: 4 });
    expect(s.gets).toHaveLength(4);
  });

  it("an archive object that cannot be read still fails the check", async () => {
    const { from, to } = await singleRowBatches(8);
    const last = await E.DB.prepare("SELECT archive_key FROM audit_log WHERE seq = ?").bind(to).first<{ archive_key: string }>();
    const s = slowBucket((key) => key === last!.archive_key);
    await expect(verifyRange(E.DB, s.bucket, from, to)).rejects.toThrow(/r2 down/);
  });
});

describe("POST /api/audit/verify (Check now)", () => {
  it(
    "reads at most MANUAL_VERIFY_ARCHIVE_OBJECTS archive objects and reports where it stopped",
    async () => {
      expect(MANUAL_VERIFY_ARCHIVE_OBJECTS).toBe(200);
      const { from, to } = await singleRowBatches(MANUAL_VERIFY_ARCHIVE_OBJECTS + 5);
      const id = await seedUser("developer", null);
      const token = await tokenFor(id, "developer", null);
      const res = await dispatch("POST", "/api/audit/verify", { headers: authHeaders(token), body: { from_seq: from, to_seq: to } });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: Record<string, unknown> };
      expect(data).toMatchObject({
        ok: true,
        fromSeq: from,
        toSeq: from + MANUAL_VERIFY_ARCHIVE_OBJECTS - 1,
        checked: MANUAL_VERIFY_ARCHIVE_OBJECTS,
        capped: true,
        archiveObjects: MANUAL_VERIFY_ARCHIVE_OBJECTS,
      });
    },
    180_000
  );
});
