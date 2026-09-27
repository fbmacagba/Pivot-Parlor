import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { sendAuditEmail } from "../services/email.js";
import { systemAudit } from "./context.js";
import { verifyRange, type VerifyResult } from "./verify.js";

export const WALK_ROWS_PER_NIGHT = 20_000;

type NightlyEnv = {
  DB: D1Database;
  AUDIT_ARCHIVE: R2Bucket;
  RESEND_API_KEY?: string;
  AUDIT_OPERATOR_EMAIL?: string;
};
type Send = typeof sendAuditEmail;

interface StoredAnchor {
  date: string;
  seq: number;
  chain_hash: string;
}

/** Ruling 30: a throw from verifyRange (a bucket read error, an unexpected
 *  exception) must not suppress the audit.verify record or the alert email
 *  the way an uncaught throw out of runAuditNightly would. Never err.message
 *  (Ruling 5) — only the error's name. firstBadSeq is set to fromSeq: fed
 *  through advanceCursor below exactly like any other structured failure,
 *  that sets last_verified_seq = fromSeq, so the NEXT run starts at
 *  fromSeq + 1 — not "retry the same range". A transient failure (bucket
 *  blip) therefore permanently skips verifying the single row at fromSeq;
 *  recorded as a Ruling 31 cost in the report, not fixed here (the
 *  alternative — leaving the cursor where it was — is what caused the
 *  original stall Ruling 31 exists to close). */
async function safeVerify(
  db: D1Database,
  bucket: R2Bucket,
  fromSeq: number,
  toSeq: number,
  opts: { requireArchived?: boolean }
): Promise<VerifyResult> {
  try {
    return await verifyRange(db, bucket, fromSeq, toSeq, opts);
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return { ok: false, fromSeq, toSeq, checked: 0, firstBadSeq: fromSeq, problem: `verify error: ${name}` };
  }
}

/** Ruling 31: never advance a cursor BACKWARDS past where it already is.
 *  verifyRange's own "no chain value before seq X" failure reports
 *  firstBadSeq = X - 1 (the last GOOD seq it could confirm, which is simply
 *  the cursor's current position when X itself is a gap) — advancing to that
 *  value would repeat the same failure every subsequent night forever, which
 *  is exactly the stall Ruling 31 forbids. Clamping to at least `fromSeq`
 *  guarantees forward progress; a gap then resolves within a few nights
 *  instead of never (seq X missing entirely means there is no stored
 *  chain_hash to seed from at X, so "seeded from the stored chain_hash at X"
 *  cannot apply in that specific case — recorded in the report). */
function advanceCursor(r: VerifyResult): number {
  return r.ok ? r.toSeq : Math.max(r.firstBadSeq ?? r.fromSeq, r.fromSeq);
}

export async function runAuditNightly(env: NightlyEnv, now = new Date(), send: Send = sendAuditEmail): Promise<void> {
  const db = env.DB;
  const state = await db.prepare("SELECT last_verified_seq, walk_cursor_seq, expired_through_seq FROM audit_seal_state WHERE id = 1")
    .first<{ last_verified_seq: number; walk_cursor_seq: number; expired_through_seq: number }>();
  const maxRow = await db.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number | null }>();
  const maxSeq = maxRow?.m ?? 0;
  const floor = (state?.expired_through_seq ?? 0) + 1;
  const lastVerifiedSeq = state?.last_verified_seq ?? 0;

  // Ruling 29: a deleted tail (the trail's own MAX(seq) regressing below what
  // was already verified) is otherwise invisible — nothing below re-scans
  // seq numbers that no longer exist.
  const newestMissing = maxSeq < lastVerifiedSeq;

  // Ruling 28: never verify a row that isn't archived yet (normal sealing/
  // archiving lag) as if its archive comparison passed — cap each scan's
  // upper bound BELOW the first unarchived seq WITHIN that scan's own
  // candidate range (not a single global ceiling: one unrelated row with a
  // nulled archived_at elsewhere in history must not block tonight's
  // incremental check on fresh entries).
  async function archivedCeiling(from: number, tentativeTo: number): Promise<number> {
    if (tentativeTo < from) return tentativeTo;
    const row = await db
      .prepare("SELECT MIN(seq) AS m FROM audit_log WHERE seq BETWEEN ? AND ? AND archived_at IS NULL")
      .bind(from, tentativeTo)
      .first<{ m: number | null }>();
    return row?.m != null ? row.m - 1 : tentativeTo;
  }

  // Moved up from the health-counts section below so it is available to the
  // Ruling 33 computation immediately following it as well.
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  // Ruling 33: archivedCeiling above can silently stop BOTH the incremental
  // scan and the rotating walk well short of MAX(seq) when a single row
  // never finishes archiving — the cap just makes incremental/walk both
  // null forever, with no problem line naming why. Name the seq once it has
  // been stuck long enough to rule out ordinary archiver lag (same 1-hour
  // threshold as the "unarchived" count below). Computed ONCE for the whole
  // run, from the first unarchived sealed seq above last_verified_seq — NOT
  // per scan range, unlike archivedCeiling (a range-scoped cap is right for
  // "don't verify this yet"; the blocked-seq report is about the trail as a
  // whole, so computing it twice would just duplicate the same answer).
  const blockedRow = await db
    .prepare("SELECT seq, sealed_at FROM audit_log WHERE seq > ? AND sealed_at IS NOT NULL AND archived_at IS NULL ORDER BY seq LIMIT 1")
    .bind(lastVerifiedSeq)
    .first<{ seq: number; sealed_at: string }>();
  const blockedAtSeq = blockedRow && blockedRow.sealed_at < iso(3600_000) ? blockedRow.seq : null;

  // 1. New entries since the last successful check.
  const incFrom = Math.max(floor, lastVerifiedSeq + 1);
  const incTentativeTo = Math.min(maxSeq, incFrom + WALK_ROWS_PER_NIGHT - 1);
  const incTo = await archivedCeiling(incFrom, incTentativeTo);
  const incremental: VerifyResult | null = incTo >= incFrom ? await safeVerify(db, env.AUDIT_ARCHIVE, incFrom, incTo, { requireArchived: true }) : null;
  if (incremental) {
    await db.prepare("UPDATE audit_seal_state SET last_verified_seq = ? WHERE id = 1").bind(advanceCursor(incremental)).run();
  }

  // 2. Rotating re-walk of older history (Plan 1 decision 9).
  let walkFrom = Math.max(floor, (state?.walk_cursor_seq ?? 0) + 1);
  if (walkFrom > maxSeq) walkFrom = floor;
  const walkTentativeTo = Math.min(maxSeq, walkFrom + WALK_ROWS_PER_NIGHT - 1);
  const walkTo = await archivedCeiling(walkFrom, walkTentativeTo);
  const walk: VerifyResult | null = walkTo >= walkFrom ? await safeVerify(db, env.AUDIT_ARCHIVE, walkFrom, walkTo, { requireArchived: true }) : null;
  if (walk) await db.prepare("UPDATE audit_seal_state SET walk_cursor_seq = ? WHERE id = 1").bind(advanceCursor(walk)).run();

  // 3. Health counts. (`iso` is defined above, ahead of the Ruling 33 check.)
  const count = async (sql: string, ...binds: unknown[]) =>
    (await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;
  // Ruling 27: a row that already carries an audit.seal.alert is excluded
  // from "unsealed" — the sealer never advances it past unsealed (Ruling 23),
  // so it would otherwise be reported as a growing backlog forever instead
  // of the one-time integrity failure it actually is. Same NOT EXISTS shape
  // sealBatch itself uses to skip these rows.
  const unsealed = await count(
    `SELECT COUNT(*) AS n FROM audit_log al WHERE al.sealed_at IS NULL AND al.occurred_at < ?
     AND NOT EXISTS (
       SELECT 1 FROM audit_log a
       WHERE a.action = 'audit.seal.alert' AND a.entity_type = 'audit_log' AND a.entity_id = al.id
     )`,
    iso(10 * 60_000)
  );
  const unarchived = await count("SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NOT NULL AND archived_at IS NULL AND sealed_at < ?", iso(3600_000));
  const unknown = await count("SELECT COUNT(*) AS n FROM audit_log WHERE outcome = 'unknown' AND occurred_at >= ?", iso(24 * 3600_000));
  // Ruling 27: rows that failed their entry_hash check at sealing time,
  // reported separately from "unsealed" (above) since sealing will never
  // resolve them on its own.
  const sealAlerts = await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.seal.alert' AND occurred_at >= ?", iso(24 * 3600_000));

  // 4. Daily anchor for the previous UTC day, plus reading back and
  // re-verifying anchors already on file (Ruling 29).
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00.000Z`) - 24 * 3600_000).toISOString().slice(0, 10);
  const dayBefore = new Date(Date.parse(`${today}T00:00:00.000Z`) - 2 * 24 * 3600_000).toISOString().slice(0, 10);
  const anchorRow = await db.prepare("SELECT seq, chain_hash FROM audit_log WHERE seq IS NOT NULL AND sealed_at < ? ORDER BY seq DESC LIMIT 1")
    .bind(`${today}T00:00:00.000Z`)
    .first<{ seq: number; chain_hash: string }>();
  const anchorKey = `anchors/${yesterday}.json`;

  // Ruling 30: the anchor step is guarded — a write failure becomes a
  // problem line, never an uncaught throw.
  let anchorWriteProblem: string | null = null;
  try {
    if (anchorRow && !(await env.AUDIT_ARCHIVE.head(anchorKey))) {
      await env.AUDIT_ARCHIVE.put(anchorKey, JSON.stringify({ date: yesterday, seq: anchorRow.seq, chain_hash: anchorRow.chain_hash }));
    }
  } catch (err) {
    anchorWriteProblem = `could not write anchor for ${yesterday}: ${err instanceof Error ? err.name : "Error"}`;
  }

  // Ruling 29: compare a stored anchor against the LIVE row at its seq (never
  // trust a freshly recomputed value — the anchor exists precisely because a
  // recompute is what an attacker who owns the DB can do). Only meaningful
  // when the anchored seq is still expected to exist (not legitimately
  // expired by retention, Task 10).
  async function checkStoredAnchor(date: string): Promise<{ anchor: StoredAnchor | null; problem: string | null }> {
    try {
      const obj = await env.AUDIT_ARCHIVE.get(`anchors/${date}.json`);
      if (!obj) return { anchor: null, problem: null };
      const stored = JSON.parse(await obj.text()) as StoredAnchor;
      if (stored.seq <= floor - 1) return { anchor: stored, problem: null };
      const row = await db.prepare("SELECT chain_hash FROM audit_log WHERE seq = ?").bind(stored.seq).first<{ chain_hash: string }>();
      if (!row || row.chain_hash !== stored.chain_hash) {
        return { anchor: stored, problem: `stored anchor for ${date} no longer matches the chain at seq ${stored.seq}` };
      }
      return { anchor: stored, problem: null };
    } catch (err) {
      return { anchor: null, problem: `could not verify stored anchor for ${date}: ${err instanceof Error ? err.name : "Error"}` };
    }
  }
  const latestAnchor = await checkStoredAnchor(yesterday);
  const priorAnchor = await checkStoredAnchor(dayBefore);

  // Ruling 32: never read the recipient from D1.
  const recipient = env.AUDIT_OPERATOR_EMAIL;
  const alertingConfigured = Boolean(recipient && env.RESEND_API_KEY);

  const problems = [
    incremental && !incremental.ok ? `Check failed at seq ${incremental.firstBadSeq}: ${incremental.problem}` : null,
    walk && !walk.ok ? `History re-walk failed at seq ${walk.firstBadSeq}: ${walk.problem}` : null,
    newestMissing ? "newest entries missing" : null,
    unsealed ? `${unsealed} entries unsealed for more than 10 minutes` : null,
    unarchived ? `${unarchived} sealed entries unarchived for more than 1 hour` : null,
    blockedAtSeq != null ? `verification blocked at seq ${blockedAtSeq}: sealed but not archived` : null,
    unknown ? `${unknown} actions in the last 24 hours have no recorded outcome` : null,
    sealAlerts ? `${sealAlerts} entries failed their integrity check when sealing` : null,
    anchorWriteProblem,
    latestAnchor.problem,
    priorAnchor.problem,
    alertingConfigured ? null : "alert email not configured",
  ].filter((x): x is string => x !== null);

  // Ruling 30: a throw here (audit_log itself unwritable) must not suppress
  // the alert email below.
  try {
    await systemAudit(db, "cron").write({
      action: "audit.verify",
      outcome: problems.length ? "failed" : "succeeded",
      reason: problems.length ? problems.join("; ").slice(0, 500) : null,
      details: {
        checked: (incremental?.checked ?? 0) + (walk?.checked ?? 0),
        incremental: incremental && { from: incremental.fromSeq, to: incremental.toSeq, ok: incremental.ok, firstBadSeq: incremental.firstBadSeq },
        walk: walk && { from: walk.fromSeq, to: walk.toSeq, ok: walk.ok, firstBadSeq: walk.firstBadSeq },
        unsealed, unarchived, unknown, sealAlerts,
        blockedAtSeq,
        anchor: anchorRow ? { date: yesterday, seq: anchorRow.seq } : null,
      },
    });
  } catch (err) {
    console.error("[audit] nightly check entry could not be written:", err instanceof Error ? err.name : err);
  }

  if (!alertingConfigured) return;

  // Minor: alert before anchor, each isolated so one send failing does not
  // suppress the other.
  if (problems.length) {
    try {
      await send(env.RESEND_API_KEY!, recipient!, "Audit trail needs attention", problems);
    } catch (err) {
      console.error("[audit] alert email failed:", err instanceof Error ? err.name : err);
    }
  }
  if (latestAnchor.anchor) {
    try {
      await send(env.RESEND_API_KEY!, recipient!, `Audit anchor ${latestAnchor.anchor.date}`, [
        `Date: ${latestAnchor.anchor.date}`,
        `Last sealed entry: ${latestAnchor.anchor.seq}`,
        `Chain fingerprint: ${latestAnchor.anchor.chain_hash}`,
        "Keep this email. It proves what the audit trail said on this date.",
      ]);
    } catch (err) {
      console.error("[audit] anchor email failed:", err instanceof Error ? err.name : err);
    }
  }
}
