import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { archiveLine, chainHash, entryHash, GENESIS, parseArchiveLine, type AuditRow } from "@repo/audit";

export interface VerifyResult {
  ok: boolean;
  fromSeq: number;
  toSeq: number;
  checked: number;
  firstBadSeq: number | null;
  problem: string | null;
  /** Ruling 54: true when the check stopped early at `maxArchiveObjects`.
   *  `toSeq` is then the last fully verified seq (not the requested upper
   *  bound), so a caller advancing a cursor to `toSeq` stays correct. */
  capped: boolean;
  /** Distinct archive objects read (one R2 GET each, failed ones included).
   *  Objects are read a page ahead, so after a failure this can include
   *  objects past the failing row; it never exceeds `maxArchiveObjects`. */
  archiveObjects: number;
}

export interface VerifyOptions {
  /** Ruling 28: fail any row that is sealed but not yet fully archived
   *  (archived_at NULL, or archive_key NULL — the latter would otherwise
   *  silently skip the archive comparison below and hide a recomputed
   *  chain). The nightly check passes true; other callers default to
   *  false so a row that simply hasn't been archived yet (normal lag) is
   *  not itself treated as tampering. */
  requireArchived?: boolean;
  /** Ruling 54: read at most this many distinct archive objects. Each is
   *  one R2 GET, and a Worker invocation has a subrequest ceiling (Workers
   *  Paid default 10,000); at one seal batch per minute a long range would
   *  exceed it. When the next row needs an object beyond the budget the
   *  check stops cleanly before that row: ok stays true, `capped` is set and
   *  `toSeq` becomes the last fully verified seq. Unset = unbounded. */
  maxArchiveObjects?: number;
}

const PAGE = 500;

/** Archive objects read at once. A Worker invocation keeps at most six
 *  connections open, so more would only queue. */
export const ARCHIVE_FETCH_CONCURRENCY = 6;

export async function verifyRange(
  db: D1Database,
  bucket: R2Bucket,
  fromSeq: number,
  toSeq: number,
  opts: VerifyOptions = {}
): Promise<VerifyResult> {
  const archives = new Map<string, Map<string, { line: string; format: number | null }>>();
  // Objects whose GET failed. The error is raised only when a row needs the
  // object, exactly where the one-at-a-time version raised it.
  const unreadable = new Map<string, unknown>();
  /** GETs made so far, failed ones included: what the budget counts. */
  const read = () => archives.size + unreadable.size;
  const fail = (checked: number, seq: number, problem: string): VerifyResult =>
    ({ ok: false, fromSeq, toSeq, checked, firstBadSeq: seq, problem, capped: false, archiveObjects: read() });

  // Minor: a caller-supplied range that is empty or backwards is a caller
  // bug, not something to silently treat as "nothing to check."
  if (fromSeq <= 0 || fromSeq > toSeq) return fail(0, fromSeq, "invalid range");
  const maxObjects = opts.maxArchiveObjects;
  if (maxObjects !== undefined && !(maxObjects >= 1)) return fail(0, fromSeq, "invalid archive object budget");

  let prev: string;
  if (fromSeq <= 1) {
    prev = GENESIS;
  } else {
    const before = await db.prepare("SELECT chain_hash FROM audit_log WHERE seq = ?").bind(fromSeq - 1).first<{ chain_hash: string }>();
    const state = await db.prepare("SELECT expired_through_seq, expired_chain_hash FROM audit_seal_state WHERE id = 1")
      .first<{ expired_through_seq: number; expired_chain_hash: string | null }>();
    const p = before?.chain_hash ?? (state?.expired_through_seq === fromSeq - 1 ? state.expired_chain_hash : null);
    if (!p) return fail(0, fromSeq - 1, `no chain value before seq ${fromSeq}`);
    prev = p;
  }

  async function load(key: string): Promise<Map<string, { line: string; format: number | null }>> {
    const m = new Map<string, { line: string; format: number | null }>();
    const obj = await bucket.get(key);
    const text = obj ? await obj.text() : "";
    for (const line of text.split("\n")) {
      if (!line) continue;
      // Ruling 30: a corrupt archive line must not throw and abort every
      // row's lookup against this object — skip just this line. Whatever
      // row's own copy this was becomes "missing from archive" below,
      // which is exactly the failure it should be.
      const parsed = parseArchiveLine(line);
      if (!parsed) continue;
      m.set(parsed.id, { line, format: parsed.format });
    }
    return m;
  }

  /** Read this page's objects ARCHIVE_FETCH_CONCURRENCY at a time, in the
   *  order its rows first need them, and never past the budget: a row whose
   *  object is left out is exactly the row the budget check stops before. */
  async function prefetch(rows: AuditRow[]): Promise<void> {
    const wanted: string[] = [];
    const picked = new Set<string>();
    for (const row of rows) {
      const key = row.archive_key;
      if (!key || archives.has(key) || unreadable.has(key) || picked.has(key)) continue;
      if (maxObjects !== undefined && read() + wanted.length >= maxObjects) break;
      picked.add(key);
      wanted.push(key);
    }
    let next = 0;
    const reader = async () => {
      while (next < wanted.length) {
        const key = wanted[next++]!;
        try {
          archives.set(key, await load(key));
        } catch (err) {
          unreadable.set(key, err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ARCHIVE_FETCH_CONCURRENCY, wanted.length) }, reader));
  }

  async function archived(key: string): Promise<Map<string, { line: string; format: number | null }>> {
    if (unreadable.has(key)) throw unreadable.get(key);
    let m = archives.get(key);
    if (m) return m;
    m = await load(key);
    archives.set(key, m);
    return m;
  }

  let expected = fromSeq;
  let checked = 0;
  while (expected <= toSeq) {
    const page = await db
      .prepare("SELECT * FROM audit_log WHERE seq >= ? AND seq <= ? ORDER BY seq LIMIT ?")
      .bind(expected, toSeq, PAGE)
      .all<AuditRow>();
    const rows = page.results ?? [];
    if (!rows.length) return fail(checked, expected, `missing seq ${expected}`);
    await prefetch(rows);
    for (const row of rows) {
      if (row.seq !== expected) return fail(checked, expected, `missing seq ${expected}`);
      if ((await entryHash(row)) !== row.entry_hash) return fail(checked, expected, "entry_hash does not match the entry");
      prev = await chainHash(prev, row.entry_hash);
      if (prev !== row.chain_hash) return fail(checked, expected, "chain_hash breaks the chain");
      if (opts.requireArchived && (row.archived_at == null || row.archive_key == null)) {
        return fail(checked, expected, "row is sealed but not archived");
      }
      if (row.archive_key) {
        // Ruling 54: stop BEFORE this row if its object would exceed the
        // budget. Every row before it is fully verified (hash, chain and
        // archive comparison), so expected - 1 is a safe cursor position.
        if (
          maxObjects !== undefined &&
          !archives.has(row.archive_key) &&
          !unreadable.has(row.archive_key) &&
          read() >= maxObjects
        ) {
          return { ok: true, fromSeq, toSeq: expected - 1, checked, firstBadSeq: null, problem: null, capped: true, archiveObjects: read() };
        }
        const copy = (await archived(row.archive_key)).get(row.id);
        if (copy === undefined) return fail(checked, expected, `entry missing from archive ${row.archive_key}`);
        // Ruling 58: compare on the column list of the format the archived
        // line itself names, so a later audit_log column (a later format)
        // never breaks lines already in the locked bucket.
        if (copy.format === null) return fail(checked, expected, `unknown archive format in ${row.archive_key}`);
        if (copy.line !== archiveLine(row, copy.format)) return fail(checked, expected, `entry differs from archive ${row.archive_key}`);
      }
      checked++;
      expected++;
    }
  }
  return { ok: true, fromSeq, toSeq, checked, firstBadSeq: null, problem: null, capped: false, archiveObjects: read() };
}
