import type { AuditRow } from "./types";

export const GENESIS = "GENESIS";

/** Columns covered by entry_hash: everything except the sealer's and the hash itself. */
const HASHED = [
  "action", "actor_ref", "actor_role", "actor_type", "changes_json", "details_json", "entity_id",
  "entity_type", "historical", "id", "ip_ref", "occurred_at", "outcome", "parent_id", "phase",
  "reason", "request_id", "shop_id", "via", "worker",
] as const;

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
