import type { D1Database } from "@cloudflare/workers-types";
import { systemAudit } from "./context.js";

export const AUDIT_RETENTION_DAYS = 2192;

/**
 * Blank name/email/IP for subjects whose redact_after has passed (spec 6.2).
 * The column set blanked is the same regardless of `kind` ('user',
 * 'visitor_ip', 'shop' — Task 6): display_name/email/ip are simply NULL for
 * whichever of them a given kind never populated in the first place.
 *
 * Ruling 39: commits through the recorder's batch API (one all-or-nothing
 * D1 batch alongside the audit entry), not statements() + a separate
 * db.batch call.
 */
export async function redactDueSubjects(db: D1Database, now: Date, max: number): Promise<number> {
  const nowIso = now.toISOString();
  const due = await db
    .prepare("SELECT id FROM audit_subjects WHERE redact_after <= ? AND redacted_at IS NULL LIMIT ?")
    .bind(nowIso, max)
    .all<{ id: string }>();
  const ids = (due.results ?? []).map((r) => r.id);
  if (!ids.length) return 0;
  const blank = ids.map((id) =>
    db
      .prepare(
        "UPDATE audit_subjects SET display_name = NULL, email = NULL, ip = NULL, redacted_at = ? WHERE id = ? AND redacted_at IS NULL"
      )
      .bind(nowIso, id)
  );
  await systemAudit(db, "cron").batch(blank, {
    action: "subject.redact",
    outcome: "succeeded",
    details: { count: ids.length, subject_ids: ids },
  });
  return ids.length;
}

/**
 * Delete archived entries older than 6 years, only as a contiguous prefix of
 * the chain (an old row sealed after younger ones — sealing order, not
 * occurrence order — waits until everything before it has expired).
 *
 * Ruling 38: a row is only a candidate once it is at or below
 * audit_seal_state.last_verified_seq — the nightly verifier's own high-water
 * mark. However old or archived a row is, it can never be expired ahead of
 * proof that the chain up to it is intact; the gate is applied to both the
 * firstKeep boundary and the candidate select itself.
 *
 * Ruling 39: commits through the recorder's batch API, alongside the
 * deletes and the audit_seal_state update, in one all-or-nothing D1 batch.
 */
export async function expireOldEntries(db: D1Database, now: Date, max: number): Promise<number> {
  const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  const sealState = await db
    .prepare("SELECT last_verified_seq FROM audit_seal_state WHERE id = 1")
    .first<{ last_verified_seq: number }>();
  const lastVerifiedSeq = sealState?.last_verified_seq ?? 0;

  const firstKeep = await db
    .prepare(
      `SELECT MIN(seq) AS s FROM audit_log
       WHERE seq IS NOT NULL AND (occurred_at >= ? OR archived_at IS NULL OR seq > ?)`
    )
    .bind(cutoff, lastVerifiedSeq)
    .first<{ s: number | null }>();

  const rows = await db
    .prepare(
      `SELECT id, seq, chain_hash FROM audit_log WHERE seq IS NOT NULL AND occurred_at < ? AND archived_at IS NOT NULL
       AND seq <= ? AND (? IS NULL OR seq < ?) ORDER BY seq LIMIT ?`
    )
    .bind(cutoff, lastVerifiedSeq, firstKeep?.s ?? null, firstKeep?.s ?? null, max)
    .all<{ id: string; seq: number; chain_hash: string }>();
  const list = rows.results ?? [];
  if (!list.length) return 0;

  const last = list[list.length - 1]!;
  const del = list.map((r) => db.prepare("DELETE FROM audit_log WHERE id = ?").bind(r.id));
  const stateUpdate = db
    .prepare("UPDATE audit_seal_state SET expired_through_seq = ?, expired_chain_hash = ? WHERE id = 1")
    .bind(last.seq, last.chain_hash);
  await systemAudit(db, "cron").batch([...del, stateUpdate], {
    action: "audit.expire",
    outcome: "succeeded",
    details: { from_seq: list[0]!.seq, to_seq: last.seq, count: list.length },
  });
  return list.length;
}
