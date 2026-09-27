import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { systemAudit } from "../src/audit/context";
import { runSealer } from "../src/audit/sealer";
import { runAuditNightly } from "../src/audit/nightly";

// Own file (own vitest-pool-workers D1) so this production-shaped, several-
// nights-in-a-row scenario starts from a totally clean trail, same reason
// audit-verify-expired-seq.test.ts is split out: it needs to reason exactly
// about seq 1..N with nothing left over from another describe block.

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket; RESEND_API_KEY?: string };
const OWNER_EMAIL = "owner@test.local";

function withEnv(overrides: Record<string, unknown> = {}) {
  return { ...E, RESEND_API_KEY: "re_test", AUDIT_OPERATOR_EMAIL: OWNER_EMAIL, ...overrides };
}

async function sealedTrail(n: number) {
  for (let i = 0; i < n; i++) await systemAudit(E.DB, "cron").write({ action: "audit.verify", outcome: "succeeded", details: { i } });
  await runSealer(E);
  const max = await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>();
  return max!.m;
}

// See the identical helper's own comment in audit-nightly.test.ts: one
// runSealer(E) call archives only the globally oldest unarchived batch, and
// runAuditNightly's own audit.verify write is an unsealed row when it lands
// -- draining until nothing is left pending resolves both the seal stage
// and the archive stage of that lag, not just one.
async function drainSealer() {
  for (let i = 0; i < 5; i++) {
    const r = await runSealer(E);
    if (!r.sealed && !r.archived) break;
  }
}

async function latestVerifyEntry() {
  return E.DB.prepare(
    "SELECT outcome, reason, details_json FROM audit_log WHERE action = 'audit.verify' AND via = 'cron' AND details_json LIKE '%checked%' ORDER BY occurred_at DESC LIMIT 1"
  ).first<{ outcome: string; reason: string | null; details_json: string }>();
}

async function sealState() {
  return E.DB.prepare("SELECT last_verified_seq, walk_cursor_seq, expired_through_seq FROM audit_seal_state WHERE id = 1")
    .first<{ last_verified_seq: number; walk_cursor_seq: number; expired_through_seq: number }>();
}

describe("runAuditNightly walk wrap (Ruling 34)", () => {
  // Ruling 34: "the walk never wraps in production" because every nightly
  // itself writes an audit.verify row that the sealer (drainSealer here,
  // standing in for the real per-minute cron) seals and archives before the
  // next run -- so something new is always sealed+archived between nightly
  // runs, exactly like a live, low-traffic system. Across several such
  // nights, the rotating walk must still return to the floor at least once
  // -- if it never does, the walk is dead code that only ever inches
  // forward by whatever the nightly's own bookkeeping adds, never actually
  // re-walking older history.
  it("returns the walk to the floor across several nights, even though something new is sealed and archived every night", async () => {
    await sealedTrail(3);
    await drainSealer();

    const froms: (number | null)[] = [];
    for (let night = 0; night < 4; night++) {
      await runAuditNightly(withEnv(), new Date(), async () => {});
      const entry = await latestVerifyEntry();
      const details = JSON.parse(entry!.details_json) as { walk: { from: number } | null };
      froms.push(details.walk?.from ?? null);
      await drainSealer(); // stand-in for the per-minute cron sealing this night's own trailing entry before the next run
    }

    const state0 = await sealState();
    const floor = (state0!.expired_through_seq ?? 0) + 1;
    // Night 1 starts at the floor trivially (nothing has walked yet) under
    // every variant of the fix, so it proves nothing on its own -- the real
    // question is whether the walk EVER returns to the floor again after
    // that, once it has caught up once.
    expect(froms.slice(1)).toContain(floor);
  });
});

describe("runAuditNightly walk resume (Task 10 carried minor c)", () => {
  // Mid-cycle: the walk has NOT yet caught up to last_verified_seq (unlike
  // the wrap scenario above), so the next run must resume right where it
  // left off, not restart from the floor.
  it("resumes the walk at walk_cursor_seq + 1 mid-cycle, not at the floor", async () => {
    await sealedTrail(6);
    await drainSealer();
    const maxSeq = (await E.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number }>())!.m;
    const state0 = await sealState();
    const floor = (state0!.expired_through_seq ?? 0) + 1;
    const midCursor = maxSeq - 2; // strictly below last_verified_seq below, and not at it
    await E.DB.prepare("UPDATE audit_seal_state SET last_verified_seq = ?, walk_cursor_seq = ? WHERE id = 1")
      .bind(maxSeq, midCursor)
      .run();

    await runAuditNightly(withEnv(), new Date(), async () => {});

    const entry = await latestVerifyEntry();
    const details = JSON.parse(entry!.details_json) as { walk: { from: number } | null };
    expect(details.walk?.from).toBe(midCursor + 1);
    expect(details.walk?.from).not.toBe(floor);
  });
});
