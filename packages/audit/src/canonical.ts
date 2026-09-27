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

/** Ruling 58: the current archive line format, recorded in every line. */
export const ARCHIVE_FORMAT = 1;

/**
 * Ruling 58: the columns each archive line format holds, in line order.
 * Archive objects live in a locked bucket for 6 years, so a format's list
 * must never change once anything has been archived with it: a new audit_log
 * column means a NEW format number with its own list, while objects already
 * written keep verifying against the list their lines name. (Before this,
 * lines were built from whatever keys `SELECT *` returned, so any ADD COLUMN
 * would have made every archived comparison fail.)
 */
export const ARCHIVE_COLUMNS: Readonly<Record<number, readonly (keyof AuditRow)[]>> = {
  1: [
    "action", "actor_ref", "actor_role", "actor_type", "chain_hash", "changes_json", "details_json",
    "entity_id", "entity_type", "entry_hash", "historical", "id", "ip_ref", "occurred_at", "outcome",
    "parent_id", "phase", "reason", "request_id", "seq", "sealed_at", "shop_id", "via", "worker",
  ],
};

/** The archived form of a sealed row in the given format (default: current):
 *  `archive_format` first, then that format's columns in its fixed order.
 *  Keys the row carries beyond that list are ignored. */
export function archiveLine(row: AuditRow, format: number = ARCHIVE_FORMAT): string {
  const cols = ARCHIVE_COLUMNS[format];
  if (!cols) throw new Error(`unknown archive format ${format}`);
  const out: Record<string, unknown> = { archive_format: format };
  for (const k of cols) out[k] = row[k] ?? null;
  return JSON.stringify(out);
}

/** Reads an archive line's entry id and format. `format` is null when the
 *  line names no format this code knows; null overall when the line is not
 *  a JSON object with a string id. */
export function parseArchiveLine(line: string): { id: string; format: number | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { id, archive_format } = parsed as { id?: unknown; archive_format?: unknown };
  if (typeof id !== "string") return null;
  const format = typeof archive_format === "number" && ARCHIVE_COLUMNS[archive_format] ? archive_format : null;
  return { id, format };
}
