import type { AuditRow } from "./types";

export const GENESIS = "GENESIS";

/** Columns covered by entry_hash: everything except the sealer's and the hash itself. */
export const HASHED = [
  "action", "actor_ref", "actor_role", "actor_type", "changes_json", "details_json", "entity_id",
  "entity_type", "historical", "id", "ip_ref", "occurred_at", "outcome", "parent_id", "phase",
  "reason", "request_id", "shop_id", "via", "worker",
] as const;

/**
 * D1/SQLite TEXT columns cannot represent a lone UTF-16 surrogate: whatever
 * string this replacement lands on, storage silently substitutes U+FFFD for
 * it. If entry_hash is computed over the in-memory string before that
 * substitution happens, a row read back later hashes differently from its
 * stored entry_hash - a permanent false tamper alarm, since audit_log is
 * immutable. This makes every string well-formed the same way D1 will, so the
 * hash computed before the write matches the hash recomputed after reading
 * the row back. Deliberately not `String.prototype.toWellFormed` (ES2024);
 * this package's lib target is ES2022.
 */
export function wellFormed(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s.charAt(i) + s.charAt(i + 1);
        i++;
      } else {
        out += "�";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "�";
    } else {
      out += s.charAt(i);
    }
  }
  return out;
}

export function canonicalJson(row: AuditRow): string {
  const out: Record<string, unknown> = {};
  for (const k of HASHED) out[k] = row[k] ?? null;
  return JSON.stringify(out);
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function entryHash(row: AuditRow): Promise<string> {
  return sha256Hex(canonicalJson(row));
}

export function chainHash(prevChain: string, entry: string): Promise<string> {
  return sha256Hex(`${prevChain}${entry}`);
}

/** The archived form of a sealed row: every column except archive bookkeeping. */
export function archiveLine(row: AuditRow): string {
  const { archived_at: _a, archive_key: _k, ...rest } = row;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(rest).sort()) sorted[k] = (rest as Record<string, unknown>)[k] ?? null;
  return JSON.stringify(sorted);
}
