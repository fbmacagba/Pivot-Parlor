import type { AuditAction } from "./actions";

export type ActorType = "developer" | "admin" | "staff" | "customer" | "system" | "anonymous";
export type Via = "dashboard" | "api" | "cron" | "queue" | "webhook";
export type Outcome = "succeeded" | "refused" | "failed" | "unknown";
export type Phase = "done" | "started" | "outcome";

export interface AuditActor {
  type: ActorType;
  userId?: string | null;
  role?: string | null;
  shopId?: string | null;
  ip?: string | null;
}

export interface AuditEntryInput {
  action: AuditAction;
  /** Required for phase "done"/"outcome"; must be omitted for "started". */
  outcome?: Outcome;
  /**
   * Permanent: hashed into entry_hash and locked by the audit_log trigger for
   * 6 years, never blanked. Never put personal data, secrets, tokens, or
   * request/response bodies here.
   */
  reason?: string | null;
  shopId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** {field: [before, after]}; filtered through CHANGE_ALLOWLIST[entityType]. */
  changes?: Record<string, [unknown, unknown]> | null;
  /**
   * Permanent: hashed into entry_hash and locked by the audit_log trigger for
   * 6 years, never blanked. Never put personal data, secrets, tokens, or
   * request/response bodies here.
   */
  details?: Record<string, unknown> | null;
  parentId?: string | null;
  phase?: Phase;
  /** Internal: historical import and tests only. */
  id?: string;
  occurredAt?: string;
  historical?: boolean;
}

/** Column order of audit_log inserts (sealing columns excluded). */
export const AUDIT_COLUMNS = [
  "id", "occurred_at", "entry_hash", "actor_type", "actor_ref", "actor_role", "via", "action",
  "phase", "outcome", "reason", "shop_id", "entity_type", "entity_id", "changes_json",
  "details_json", "request_id", "parent_id", "worker", "ip_ref", "historical",
] as const;

export interface AuditRow {
  id: string;
  occurred_at: string;
  seq: number | null;
  sealed_at: string | null;
  archived_at: string | null;
  archive_key: string | null;
  entry_hash: string;
  chain_hash: string | null;
  actor_type: ActorType;
  actor_ref: string | null;
  actor_role: string | null;
  via: Via;
  action: string;
  phase: Phase;
  outcome: Outcome | null;
  reason: string | null;
  shop_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  changes_json: string | null;
  details_json: string | null;
  request_id: string | null;
  parent_id: string | null;
  worker: string;
  ip_ref: string | null;
  historical: number;
}
