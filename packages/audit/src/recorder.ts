import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { isAuditAction } from "./actions";
import { filterChanges } from "./allowlist";
import { entryHash, wellFormed } from "./canonical";
import { AUDIT_COLUMNS, type AuditActor, type AuditEntryInput, type AuditRow, type Outcome, type Via } from "./types";

export class AuditWriteError extends Error {
  constructor(message: string, readonly original?: unknown) {
    super(message);
    this.name = "AuditWriteError";
  }
}

export interface RecorderBase {
  db: D1Database;
  worker: string;
  via: Via;
  actor: AuditActor;
  requestId: string | null;
  /**
   * Called once the audit entry — and any `changes` batched alongside it via
   * `batch()` — have actually COMMITTED, never merely prepared or attempted.
   * The API worker's gap guard reads this as "this request produced a
   * committed audit entry," so `statements()` alone must never trigger it.
   */
  onWrite?: () => void;
  now?: () => Date;
}

export interface AuditRunResult {
  outcome?: Outcome;
  reason?: string | null;
  details?: Record<string, unknown> | null;
  changes?: Record<string, [unknown, unknown]> | null;
  entityId?: string | null;
  /** Known only after the work ran (e.g. a webhook's shop); the started row keeps the input's. */
  shopId?: string | null;
  entityType?: string | null;
}

/** What a THROWN body had already committed, for its failed outcome. Never
 *  `changes` (a failure records no change), an outcome or a reason. */
export type AuditRunErrorResult = Partial<Pick<AuditRunResult, "details" | "shopId" | "entityType" | "entityId">>;

export interface AuditRunOptions {
  /**
   * Called only when the body throws, with the thrown value. Its `details`
   * merge over the input's on the failed outcome; `shopId`, `entityType` and
   * `entityId` replace the input's when set. Only those four keys are read.
   * A hook that throws is ignored (the outcome is recorded as without it),
   * and the original error is always rethrown unchanged.
   */
  describeError?: (err: unknown) => AuditRunErrorResult;
}

export interface AuditRecorder {
  statements(input: AuditEntryInput): Promise<D1PreparedStatement[]>;
  write(input: AuditEntryInput): Promise<string>;
  /**
   * Commit `changes` and the audit entry in ONE batch (all-or-nothing). A
   * prepare failure throws AuditWriteError (unchanged semantics); a batch
   * failure propagates the original, unwrapped error — the caller's whole
   * operation failed, not merely the audit write. `onWrite` fires only once
   * the batch has committed.
   */
  batch(changes: D1PreparedStatement[], input: AuditEntryInput): Promise<void>;
  run<T>(
    input: Omit<AuditEntryInput, "outcome" | "phase">,
    fn: () => Promise<T>,
    describe?: (result: T) => AuditRunResult,
    options?: AuditRunOptions
  ): Promise<T>;
}

export const userSubjectId = (userId: string): string => `subj_user_${userId}`;

const REASON_MAX = 500;
const DAY_MS = 24 * 3600 * 1000;

/** Truncate by Unicode code point, never mid-surrogate-pair (unlike String.slice). */
function truncateCodePoints(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

/** Every string column, well-formed, so the hash computed now matches what D1 stores. */
function sanitizeRow(row: AuditRow): AuditRow {
  const out: Record<string, unknown> = { ...row };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (typeof v === "string") out[k] = wellFormed(v);
  }
  return out as unknown as AuditRow;
}

/**
 * Structured, not the thrown error's message: reason is hashed into
 * entry_hash and locked by the audit_log trigger for 6 years, and vendor
 * error messages (e.g. LlmError) can carry response/request text that must
 * never be stored permanently.
 */
function errorReason(err: unknown): string {
  const name = err instanceof Error ? err.name : "Error";
  const status =
    err && typeof err === "object" && "status" in err && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : undefined;
  return status !== undefined ? `${name} (HTTP ${status})` : name;
}

/** The effects `describeError` reports for a thrown body: only its four
 *  keys are copied (a cast cannot smuggle `changes` in), and a hook that
 *  throws or returns a non-object reports nothing. */
function errorEffects(options: AuditRunOptions | undefined, err: unknown): AuditRunErrorResult {
  if (!options?.describeError) return {};
  let out: unknown;
  try {
    out = options.describeError(err);
  } catch {
    return {};
  }
  if (!out || typeof out !== "object") return {};
  const e = out as AuditRunErrorResult;
  return {
    details: e.details && typeof e.details === "object" ? e.details : undefined,
    shopId: e.shopId,
    entityType: e.entityType,
    entityId: e.entityId,
  };
}

export function createAuditRecorder(base: RecorderBase): AuditRecorder {
  const nowIso = () => (base.now?.() ?? new Date()).toISOString();

  async function subjects(at: string): Promise<{ actorRef: string | null; ipRef: string | null; stmts: D1PreparedStatement[] }> {
    const stmts: D1PreparedStatement[] = [];
    let actorRef: string | null = null;
    if (base.actor.userId) {
      actorRef = userSubjectId(base.actor.userId);
      stmts.push(
        base.db
          .prepare(
            `INSERT INTO audit_subjects (id, kind, user_id, shop_id, display_name, email, created_at)
             SELECT ?, 'user', pu.id, pu.shop_id, pu.name, pu.email, ? FROM platform_users pu WHERE pu.id = ?
             ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, email = excluded.email,
               shop_id = excluded.shop_id
             WHERE audit_subjects.redacted_at IS NULL`
          )
          .bind(actorRef, at, base.actor.userId)
      );
    }
    let ipRef: string | null = null;
    const ip = base.actor.ip?.trim();
    if (ip) {
      const day = at.slice(0, 10);
      const found = await base.db
        .prepare("SELECT id FROM audit_subjects WHERE kind = 'visitor_ip' AND day = ? AND ip = ? LIMIT 1")
        .bind(day, ip)
        .first<{ id: string }>();
      if (found) {
        ipRef = found.id;
      } else {
        ipRef = `subj_ip_${crypto.randomUUID()}`;
        const redactAfter = new Date(Date.parse(at) + 30 * DAY_MS).toISOString();
        stmts.push(
          base.db
            .prepare(
              "INSERT INTO audit_subjects (id, kind, ip, day, created_at, redact_after) VALUES (?, 'visitor_ip', ?, ?, ?, ?)"
            )
            .bind(ipRef, ip, day, at, redactAfter)
        );
      }
    }
    return { actorRef, ipRef, stmts };
  }

  async function prepare(input: AuditEntryInput): Promise<{ id: string; stmts: D1PreparedStatement[] }> {
    try {
      if (!isAuditAction(input.action)) throw new AuditWriteError(`Unknown audit action: ${String(input.action)}`);
      const phase = input.phase ?? "done";
      if (phase === "started" && input.outcome) throw new AuditWriteError("A started entry has no outcome");
      if (phase !== "started" && !input.outcome) throw new AuditWriteError("outcome is required");
      const at = input.occurredAt ?? nowIso();
      const refs = await subjects(at);
      const changes = filterChanges(input.entityType, input.changes);
      const row: AuditRow = {
        id: input.id ?? crypto.randomUUID(),
        occurred_at: at,
        seq: null, sealed_at: null, archived_at: null, archive_key: null, chain_hash: null,
        entry_hash: "",
        actor_type: base.actor.type,
        actor_ref: refs.actorRef,
        actor_role: base.actor.role ?? null,
        via: base.via,
        action: input.action,
        phase,
        outcome: phase === "started" ? null : input.outcome!,
        reason: input.reason ? truncateCodePoints(input.reason, REASON_MAX) : null,
        shop_id: input.shopId ?? null,
        entity_type: input.entityType ?? null,
        entity_id: input.entityId ?? null,
        changes_json: changes ? JSON.stringify(changes) : null,
        details_json: input.details ? JSON.stringify(input.details) : null,
        request_id: base.requestId,
        parent_id: input.parentId ?? null,
        worker: base.worker,
        ip_ref: refs.ipRef,
        historical: input.historical ? 1 : 0,
      };
      const sanitized = sanitizeRow(row);
      sanitized.entry_hash = await entryHash(sanitized);
      const insert = base.db
        .prepare(
          `INSERT INTO audit_log (${AUDIT_COLUMNS.join(", ")}) VALUES (${AUDIT_COLUMNS.map(() => "?").join(", ")})`
        )
        .bind(...AUDIT_COLUMNS.map((c) => sanitized[c]));
      return { id: sanitized.id, stmts: [...refs.stmts, insert] };
    } catch (err) {
      throw err instanceof AuditWriteError ? err : new AuditWriteError("Audit entry could not be prepared", err);
    }
  }

  async function write(input: AuditEntryInput): Promise<string> {
    const { id, stmts } = await prepare(input);
    try {
      await base.db.batch(stmts);
    } catch (err) {
      throw new AuditWriteError("Audit entry could not be written", err);
    }
    base.onWrite?.();
    return id;
  }

  /**
   * Commit `changes` and the audit entry in ONE batch. Unlike `write()`, a
   * batch failure here propagates the ORIGINAL error, unwrapped: the
   * caller's whole operation failed (not just the audit write), so the API
   * worker should see a generic error, not an audit-refusal 503.
   */
  async function batch(changes: D1PreparedStatement[], input: AuditEntryInput): Promise<void> {
    const { stmts } = await prepare(input);
    await base.db.batch([...changes, ...stmts]);
    base.onWrite?.();
  }

  async function writeOutcome(input: AuditEntryInput): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await write(input);
        return;
      } catch (err) {
        if (attempt === 1) {
          // The action already happened; audit_log forbids updating an existing
          // row's outcome, so a later process (the sealer) inserts a separate
          // outcome row with outcome "unknown" once the started row ages out.
          console.error("[audit] outcome entry could not be written", input.action, input.parentId, err);
        }
      }
    }
  }

  return {
    async statements(input) {
      return (await prepare(input)).stmts;
    },
    write,
    batch,
    async run<T>(
      input: Omit<AuditEntryInput, "outcome" | "phase">,
      fn: () => Promise<T>,
      describe?: (result: T) => AuditRunResult,
      options?: AuditRunOptions
    ): Promise<T> {
      const startedId = await write({ ...input, phase: "started" });
      let result: T;
      try {
        result = await fn();
      } catch (err) {
        // Without a describeError hook (or with one that reports nothing) this
        // is exactly the input plus the failure, as before the hook existed.
        const effects = errorEffects(options, err);
        await writeOutcome({
          ...input,
          phase: "outcome",
          outcome: "failed",
          reason: errorReason(err),
          details: effects.details ? { ...input.details, ...effects.details } : input.details,
          shopId: effects.shopId ?? input.shopId,
          entityType: effects.entityType ?? input.entityType,
          entityId: effects.entityId ?? input.entityId,
          parentId: startedId,
        });
        throw err;
      }
      const extra = describe ? describe(result) : {};
      await writeOutcome({
        ...input,
        phase: "outcome",
        outcome: extra.outcome ?? "succeeded",
        reason: extra.reason ?? null,
        details: extra.details ?? input.details ?? null,
        changes: extra.changes ?? input.changes ?? null,
        entityId: extra.entityId ?? input.entityId ?? null,
        shopId: extra.shopId ?? input.shopId ?? null,
        entityType: extra.entityType ?? input.entityType ?? null,
        parentId: startedId,
      });
      return result;
    },
  };
}
