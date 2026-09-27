import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { sendAuditEmail } from "../services/email.js";
import { systemAudit } from "./context.js";
import { verifyRange, type VerifyResult } from "./verify.js";

export const WALK_ROWS_PER_NIGHT = 20_000;

type NightlyEnv = { DB: D1Database; AUDIT_ARCHIVE: R2Bucket; RESEND_API_KEY?: string };
type Send = typeof sendAuditEmail;

export async function runAuditNightly(env: NightlyEnv, now = new Date(), send: Send = sendAuditEmail): Promise<void> {
  const db = env.DB;
  const state = await db.prepare("SELECT last_verified_seq, walk_cursor_seq, expired_through_seq FROM audit_seal_state WHERE id = 1")
    .first<{ last_verified_seq: number; walk_cursor_seq: number; expired_through_seq: number }>();
  const maxRow = await db.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number | null }>();
  const maxSeq = maxRow?.m ?? 0;
  const floor = (state?.expired_through_seq ?? 0) + 1;

  // 1. New entries since the last successful check.
  const incFrom = Math.max(floor, (state?.last_verified_seq ?? 0) + 1);
  const incTo = Math.min(maxSeq, incFrom + WALK_ROWS_PER_NIGHT - 1);
  const incremental: VerifyResult | null = incTo >= incFrom ? await verifyRange(db, env.AUDIT_ARCHIVE, incFrom, incTo) : null;
  if (incremental?.ok) {
    await db.prepare("UPDATE audit_seal_state SET last_verified_seq = ? WHERE id = 1").bind(incTo).run();
  }

  // 2. Rotating re-walk of older history (Plan 1 decision 9).
  let walkFrom = Math.max(floor, (state?.walk_cursor_seq ?? 0) + 1);
  if (walkFrom > maxSeq) walkFrom = floor;
  const walkTo = Math.min(maxSeq, walkFrom + WALK_ROWS_PER_NIGHT - 1);
  const walk: VerifyResult | null = walkTo >= walkFrom ? await verifyRange(db, env.AUDIT_ARCHIVE, walkFrom, walkTo) : null;
  if (walk) await db.prepare("UPDATE audit_seal_state SET walk_cursor_seq = ? WHERE id = 1").bind(walk.ok ? walkTo : 0).run();

  // 3. Health counts.
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
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

  // 4. Daily anchor for the previous UTC day.
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00.000Z`) - 24 * 3600_000).toISOString().slice(0, 10);
  const anchorRow = await db.prepare("SELECT seq, chain_hash FROM audit_log WHERE seq IS NOT NULL AND sealed_at < ? ORDER BY seq DESC LIMIT 1")
    .bind(`${today}T00:00:00.000Z`)
    .first<{ seq: number; chain_hash: string }>();
  const anchorKey = `anchors/${yesterday}.json`;
  if (anchorRow && !(await env.AUDIT_ARCHIVE.head(anchorKey))) {
    await env.AUDIT_ARCHIVE.put(anchorKey, JSON.stringify({ date: yesterday, seq: anchorRow.seq, chain_hash: anchorRow.chain_hash }));
  }

  const problems = [
    incremental && !incremental.ok ? `Check failed at seq ${incremental.firstBadSeq}: ${incremental.problem}` : null,
    walk && !walk.ok ? `History re-walk failed at seq ${walk.firstBadSeq}: ${walk.problem}` : null,
    unsealed ? `${unsealed} entries unsealed for more than 10 minutes` : null,
    unarchived ? `${unarchived} sealed entries unarchived for more than 1 hour` : null,
    unknown ? `${unknown} actions in the last 24 hours have no recorded outcome` : null,
    sealAlerts ? `${sealAlerts} entries failed their integrity check when sealing` : null,
  ].filter((x): x is string => x !== null);

  await systemAudit(db, "cron").write({
    action: "audit.verify",
    outcome: problems.length ? "failed" : "succeeded",
    reason: problems.length ? problems.join("; ").slice(0, 500) : null,
    details: {
      checked: (incremental?.checked ?? 0) + (walk?.checked ?? 0),
      incremental: incremental && { from: incremental.fromSeq, to: incremental.toSeq, ok: incremental.ok },
      walk: walk && { from: walk.fromSeq, to: walk.toSeq, ok: walk.ok },
      unsealed, unarchived, unknown, sealAlerts,
      anchor: anchorRow ? { date: yesterday, seq: anchorRow.seq } : null,
    },
  });

  const dev = await db.prepare("SELECT email FROM platform_users WHERE role = 'developer' LIMIT 1").first<{ email: string }>();
  if (!dev?.email || !env.RESEND_API_KEY) return;
  if (anchorRow) {
    await send(env.RESEND_API_KEY, dev.email, `Audit anchor ${yesterday}`, [
      `Date: ${yesterday}`,
      `Last sealed entry: ${anchorRow.seq}`,
      `Chain fingerprint: ${anchorRow.chain_hash}`,
      "Keep this email. It proves what the audit trail said on this date.",
    ]);
  }
  if (problems.length) {
    await send(env.RESEND_API_KEY, dev.email, "Audit trail needs attention", problems);
  }
}
