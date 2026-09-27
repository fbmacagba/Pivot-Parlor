import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { archiveLine, chainHash, entryHash, GENESIS, isAuditAction, type AuditRow } from "@repo/audit";
import { systemAudit } from "./context.js";

export const SEAL_BATCH = 500;
export const ARCHIVE_BATCH = 500;
/** Ruling 59: seal batches archived per sealer run (one object each). */
export const ARCHIVE_BATCHES_PER_RUN = 5;
export const LEASE_MS = 50_000;
export const STALE_STARTED_MS = 15 * 60_000;
/** Ruling 26: bound the stale-started scan's lower edge so it never becomes
 *  a full-table scan over 6 years of history; a started row stranded longer
 *  than this is never marked unknown by the minute sealer (the nightly check
 *  still sees it). */
const STALE_STARTED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

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
    // Ruling 25: the crash-visibility step (marking stale "started" rows
    // unknown) must never stop the chain. Guarded at two levels: each row's
    // write is caught individually (below), and the step itself is caught
    // here in case the SELECT that finds candidates fails outright.
    let unknownMarked = 0;
    try {
      unknownMarked = await markUnknownOutcomes(env.DB, now);
    } catch (err) {
      console.error("[audit] unknown-outcome step failed; continuing to seal:", err instanceof Error ? err.message : err);
    }

    // A sealBatch failure must not skip archiving: there may be an existing
    // backlog of sealed-but-unarchived rows from a previous run that still
    // needs to reach R2 even if nothing new gets sealed this minute.
    let sealed = 0;
    let tampered: string[] = [];
    try {
      const result = await sealBatch(env.DB, nowIso);
      sealed = result.sealed;
      tampered = result.tampered;
    } catch (err) {
      console.error("[audit] seal step failed; will retry next run:", err instanceof Error ? err.message : err);
    }
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
  const lookback = new Date(now.getTime() - STALE_STARTED_MS - STALE_STARTED_LOOKBACK_MS).toISOString();
  const stale = await db
    .prepare(
      `SELECT * FROM audit_log s WHERE s.phase = 'started' AND s.occurred_at >= ? AND s.occurred_at < ?
       AND NOT EXISTS (SELECT 1 FROM audit_log o WHERE o.parent_id = s.id)
       ORDER BY s.occurred_at LIMIT 100`
    )
    .bind(lookback, cutoff)
    .all<AuditRow>();
  let marked = 0;
  for (const s of stale.results ?? []) {
    // Narrows s.action to AuditAction so no `as never`/`as AuditAction` cast
    // is needed; a row whose action somehow fell outside the catalogue is
    // logged and skipped rather than blindly cast through.
    if (!isAuditAction(s.action)) {
      console.error("[audit] started row has an action outside the catalogue; skipping unknown-outcome write", s.id, s.action);
      continue;
    }
    try {
      // A fresh recorder per row (not one shared instance) so each unknown-
      // outcome entry copies ITS OWN started row's request_id, rather than
      // whatever requestId the loop's shared recorder happened to be built
      // with (systemAudit's requestId is fixed per recorder, not per write).
      await systemAudit(db, "cron", s.request_id).write({
        action: s.action,
        phase: "outcome",
        outcome: "unknown",
        reason: "no outcome recorded within 15 minutes",
        shopId: s.shop_id,
        entityType: s.entity_type,
        entityId: s.entity_id,
        parentId: s.id,
      });
      marked += 1;
    } catch (err) {
      console.error("[audit] could not write unknown-outcome for stale started row", s.id, err);
    }
  }
  return marked;
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
    .prepare(
      // Ruling 23: a row that already carries an audit.seal.alert is excluded
      // here, not merely skipped after being read - it is never re-selected
      // once alerted, so a stall behind up to SEAL_BATCH permanently-tampered
      // rows cannot happen on the normal (single active lease) path.
      `SELECT * FROM audit_log al WHERE al.sealed_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM audit_log a
         WHERE a.action = 'audit.seal.alert' AND a.entity_type = 'audit_log' AND a.entity_id = al.id
       )
       ORDER BY al.occurred_at, al.id LIMIT ?`
    )
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
  // Minor (b): the true count of rows actually updated (D1's reported
  // meta.changes), not merely the number of UPDATE statements attempted.
  const results = stmts.length ? await db.batch(stmts) : [];
  const sealed = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  return { sealed, tampered };
}

/**
 * Ruling 22: an entry_hash mismatch at sealing time is a tamper alert, not
 * merely a console line, deduplicated by checking for a prior alert against
 * the same entity_id before writing (Ruling 22 is still binding - Ruling 23
 * added an exclusion in sealBatch, it did not retract this one).
 *
 * Ruling 23's sealBatch exclusion covers the normal path (a single active
 * lease): a row already alerted is never re-selected, so this lookup would
 * always find nothing there. It stays load-bearing for the lease-overrun
 * case that Ruling 23 does not close - run A selects tampered row R, runs
 * past LEASE_MS before writing R's alert, run B takes the lease and selects
 * R too (no alert exists yet, so Ruling 23's exclusion does not yet apply),
 * and both runs reach alertTampered for R. No test discriminates this
 * lookup: sealBatch's exclusion means it is unreachable-in-practice on
 * every path this suite can drive, and the race it actually guards needs
 * two overlapping leases to trigger.
 */
async function alertTampered(db: D1Database, tampered: string[]): Promise<void> {
  const rec = systemAudit(db, "cron");
  for (const id of tampered) {
    try {
      const existing = await db
        .prepare("SELECT 1 FROM audit_log WHERE action = 'audit.seal.alert' AND entity_type = 'audit_log' AND entity_id = ? LIMIT 1")
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

/**
 * Ruling 24: each object holds exactly ONE seal batch (one shared sealed_at
 * value), so the object key - built from that batch's first/last seq and
 * its own sealed_at - is deterministic and reproducible on retry. Archiving
 * rows from more than one sealed_at value under a single key broke that: a
 * retry after a growing backlog would recompute a wider key than the one
 * already written to a locked (overwrite-refusing) bucket.
 */
export async function archivePending(db: D1Database, bucket: R2Bucket, nowIso: string): Promise<number> {
  // Ruling 59: up to ARCHIVE_BATCHES_PER_RUN batches per run, so a backlog
  // (an R2 outage, a burst of small batches) drains in minutes rather than
  // one batch per minute. Each batch is still its own object with its own
  // deterministic key (Ruling 24). An error stops the loop and propagates
  // (runSealer records it as archiveError; that run then reports archived
  // 0 even if earlier batches in it succeeded -- they are durably marked,
  // only the count in that one SealResult is understated).
  let total = 0;
  for (let i = 0; i < ARCHIVE_BATCHES_PER_RUN; i++) {
    const n = await archiveOneBatch(db, bucket, nowIso);
    if (!n) break;
    total += n;
  }
  return total;
}

async function archiveOneBatch(db: D1Database, bucket: R2Bucket, nowIso: string): Promise<number> {
  const res = await db
    .prepare(
      `SELECT * FROM audit_log
       WHERE archived_at IS NULL
         AND sealed_at = (SELECT MIN(sealed_at) FROM audit_log WHERE sealed_at IS NOT NULL AND archived_at IS NULL)
       ORDER BY seq LIMIT ?`
    )
    .bind(ARCHIVE_BATCH)
    .all<AuditRow>();
  const rows = res.results ?? [];
  if (!rows.length) return 0;
  const first = rows[0]!.seq!;
  const last = rows[rows.length - 1]!.seq!;
  const sealedAt = rows[0]!.sealed_at!;
  const key = archiveKey(first, last, sealedAt);
  // Not `rows.map(archiveLine)`: map's index argument would be read as the
  // archive format (Ruling 58).
  const body = rows.map((r) => archiveLine(r)).join("\n") + "\n";
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
