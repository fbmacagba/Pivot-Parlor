import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { archiveLine, chainHash, entryHash, GENESIS, type AuditRow } from "@repo/audit";

export interface VerifyResult {
  ok: boolean;
  fromSeq: number;
  toSeq: number;
  checked: number;
  firstBadSeq: number | null;
  problem: string | null;
}

const PAGE = 500;

export async function verifyRange(db: D1Database, bucket: R2Bucket, fromSeq: number, toSeq: number): Promise<VerifyResult> {
  const fail = (checked: number, seq: number, problem: string): VerifyResult =>
    ({ ok: false, fromSeq, toSeq, checked, firstBadSeq: seq, problem });

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

  const archives = new Map<string, Map<string, string>>();
  async function archived(key: string): Promise<Map<string, string>> {
    let m = archives.get(key);
    if (m) return m;
    m = new Map();
    const obj = await bucket.get(key);
    const text = obj ? await obj.text() : "";
    for (const line of text.split("\n")) {
      if (!line) continue;
      const id = (JSON.parse(line) as { id: string }).id;
      m.set(id, line);
    }
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
    for (const row of rows) {
      if (row.seq !== expected) return fail(checked, expected, `missing seq ${expected}`);
      if ((await entryHash(row)) !== row.entry_hash) return fail(checked, expected, "entry_hash does not match the entry");
      prev = await chainHash(prev, row.entry_hash);
      if (prev !== row.chain_hash) return fail(checked, expected, "chain_hash breaks the chain");
      if (row.archive_key) {
        const copy = (await archived(row.archive_key)).get(row.id);
        if (copy === undefined) return fail(checked, expected, `entry missing from archive ${row.archive_key}`);
        if (copy !== archiveLine(row)) return fail(checked, expected, `entry differs from archive ${row.archive_key}`);
      }
      checked++;
      expected++;
    }
  }
  return { ok: true, fromSeq, toSeq, checked, firstBadSeq: null, problem: null };
}
