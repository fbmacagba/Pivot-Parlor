import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { archiveLine, chainHash, entryHash, GENESIS, type AuditRow } from "@repo/audit";
import { systemAudit } from "./context.js";

export const SEAL_BATCH = 500;
export const ARCHIVE_BATCH = 500;
export const LEASE_MS = 50_000;
export const STALE_STARTED_MS = 15 * 60_000;

export interface SealResult {
  skipped: boolean;
  sealed: number;
  archived: number;
  unknownMarked: number;
  tampered: string[];
  archiveError?: string;
}

type SealEnv = { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

const pad = (n: number) => String(n).padStart(12, "0");

export function archiveKey(firstSeq: number, lastSeq: number, sealedAt: string): string {
  return `${sealedAt.slice(0, 10).replace(/-/g, "/")}/${pad(firstSeq)}-${pad(lastSeq)}.jsonl`;
}

export async function runSealer(env: SealEnv, now = new Date()): Promise<SealResult> {
  const holder = crypto.randomUUID();
  const nowIso = now.toISOString();
  const lease = await env.DB.prepare(
    "UPDATE audit_seal_state SET holder = ?, lease_until = ? WHERE id = 1 AND (lease_until IS NULL OR lease_until < ?)"
  )
    .bind(holder, new Date(now.getTime() + LEASE_MS).toISOString(), nowIso)
    .run();
  if ((lease.meta?.changes ?? 0) === 0) {
    return { skipped: true, sealed: 0, archived: 0, unknownMarked: 0, tampered: [] };
  }
  try {
    const unknownMarked = await markUnknownOutcomes(env.DB, now);
    const { sealed, tampered } = await sealBatch(env.DB, nowIso);
    if (tampered.length) {
      console.error("[audit] entry_hash mismatch on unsealed rows:", tampered.join(","));
      await alertTampered(env.DB, tampered);
    }
    let archived = 0;
    let archiveError: string | undefined;
    try {
      archived = await archivePending(env.DB, env.AUDIT_ARCHIVE, nowIso);
    } catch (err) {
      archiveError = err instanceof Error ? err.message : String(err);
      console.error("[audit] archive failed; will retry next run:", archiveError);
    }
    return { skipped: false, sealed, archived, unknownMarked, tampered, ...(archiveError ? { archiveError } : {}) };
  } finally {
    await env.DB.prepare("UPDATE audit_seal_state SET holder = NULL, lease_until = NULL WHERE id = 1 AND holder = ?")
      .bind(holder)
      .run();
  }
}

async function markUnknownOutcomes(db: D1Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_STARTED_MS).toISOString();
  const stale = await db
    .prepare(
      `SELECT * FROM audit_log s WHERE s.phase = 'started' AND s.occurred_at < ?
       AND NOT EXISTS (SELECT 1 FROM audit_log o WHERE o.parent_id = s.id) LIMIT 100`
    )
    .bind(cutoff)
    .all<AuditRow>();
  const rec = systemAudit(db, "cron");
  for (const s of stale.results ?? []) {
    await rec.write({
      action: s.action as never,
      phase: "outcome",
      outcome: "unknown",
      reason: "no outcome recorded within 15 minutes",
      shopId: s.shop_id,
      entityType: s.entity_type,
      entityId: s.entity_id,
      parentId: s.id,
    });
  }
  return stale.results?.length ?? 0;
}

async function sealBatch(db: D1Database, nowIso: string): Promise<{ sealed: number; tampered: string[] }> {
  const last = await db
    .prepare("SELECT seq, chain_hash FROM audit_log WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1")
    .first<{ seq: number; chain_hash: string }>();
  const state = await db.prepare("SELECT expired_through_seq, expired_chain_hash FROM audit_seal_state WHERE id = 1")
    .first<{ expired_through_seq: number; expired_chain_hash: string | null }>();
  let seq = last?.seq ?? state?.expired_through_seq ?? 0;
  let prev = last?.chain_hash ?? state?.expired_chain_hash ?? GENESIS;
  const rows = await db
    .prepare("SELECT * FROM audit_log WHERE sealed_at IS NULL ORDER BY occurred_at, id LIMIT ?")
    .bind(SEAL_BATCH)
    .all<AuditRow>();
  const stmts = [];
  const tampered: string[] = [];
  for (const row of rows.results ?? []) {
    if ((await entryHash(row)) !== row.entry_hash) {
      tampered.push(row.id);
      continue;
    }
    seq += 1;
    prev = await chainHash(prev, row.entry_hash);
    stmts.push(
      db.prepare("UPDATE audit_log SET seq = ?, sealed_at = ?, chain_hash = ? WHERE id = ? AND sealed_at IS NULL")
        .bind(seq, nowIso, prev, row.id)
    );
  }
  if (stmts.length) await db.batch(stmts);
  return { sealed: stmts.length, tampered };
}

/**
 * Ruling 22: an entry_hash mismatch at sealing time is a tamper alert, not
 * merely a console line. The tampered row is skipped by sealBatch and stays
 * unsealed forever, so it is re-seen (and re-tampered-detected) on every
 * subsequent run; write the alert entry at most once per victim row by
 * checking for a prior audit.seal.alert against the same entity_id first.
 * A failed alert write is logged and simply retried next run, since the
 * victim row is still unsealed and no alert exists yet - it must never
 * abort archiving.
 */
async function alertTampered(db: D1Database, tampered: string[]): Promise<void> {
  const rec = systemAudit(db, "cron");
  for (const id of tampered) {
    try {
      const existing = await db
        .prepare("SELECT 1 FROM audit_log WHERE action = 'audit.seal.alert' AND entity_id = ? LIMIT 1")
        .bind(id)
        .first();
      if (existing) continue;
      await rec.write({
        action: "audit.seal.alert",
        outcome: "failed",
        reason: "entry_hash mismatch",
        entityType: "audit_log",
        entityId: id,
      });
    } catch (err) {
      console.error("[audit] could not write seal.alert for tampered row", id, err);
    }
  }
}

export async function archivePending(db: D1Database, bucket: R2Bucket, nowIso: string): Promise<number> {
  const res = await db
    .prepare("SELECT * FROM audit_log WHERE sealed_at IS NOT NULL AND archived_at IS NULL ORDER BY seq LIMIT ?")
    .bind(ARCHIVE_BATCH)
    .all<AuditRow>();
  const rows = res.results ?? [];
  if (!rows.length) return 0;
  const first = rows[0]!.seq!;
  const last = rows[rows.length - 1]!.seq!;
  const key = archiveKey(first, last, rows[0]!.sealed_at!);
  const body = rows.map(archiveLine).join("\n") + "\n";
  if (await bucket.head(key)) {
    // Locked buckets refuse overwrites: accept an identical earlier upload.
    const existing = await bucket.get(key);
    if ((await existing?.text()) !== body) throw new Error(`archive conflict at ${key}`);
  } else {
    await bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });
  }
  await db
    .prepare("UPDATE audit_log SET archived_at = ?, archive_key = ? WHERE seq BETWEEN ? AND ? AND archived_at IS NULL")
    .bind(nowIso, key, first, last)
    .run();
  return rows.length;
}
