import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { isAuditAction } from "./actions";
import { filterChanges } from "./allowlist";
import { entryHash } from "./canonical";
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
  /** Called when statements are handed out; the API worker's gap guard uses it. */
  onWrite?: () => void;
  now?: () => Date;
}

export interface AuditRunResult {
  outcome?: Outcome;
  reason?: string | null;
  details?: Record<string, unknown> | null;
  changes?: Record<string, [unknown, unknown]> | null;
  entityId?: string | null;
}

export interface AuditRecorder {
  statements(input: AuditEntryInput): Promise<D1PreparedStatement[]>;
  write(input: AuditEntryInput): Promise<string>;
  run<T>(
    input: Omit<AuditEntryInput, "outcome" | "phase">,
    fn: () => Promise<T>,
    describe?: (result: T) => AuditRunResult
  ): Promise<T>;
}

export const userSubjectId = (userId: string): string => `subj_user_${userId}`;

const REASON_MAX = 500;
const DAY_MS = 24 * 3600 * 1000;

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, REASON_MAX);
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
        reason: input.reason ? input.reason.slice(0, REASON_MAX) : null,
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
      row.entry_hash = await entryHash(row);
      const insert = base.db
        .prepare(
          `INSERT INTO audit_log (${AUDIT_COLUMNS.join(", ")}) VALUES (${AUDIT_COLUMNS.map(() => "?").join(", ")})`
        )
        .bind(...AUDIT_COLUMNS.map((c) => row[c]));
      base.onWrite?.();
      return { id: row.id, stmts: [...refs.stmts, insert] };
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
    return id;
  }

  async function writeOutcome(input: AuditEntryInput): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await write(input);
        return;
      } catch (err) {
        if (attempt === 1) {
          // The action already happened; the sealer marks the started row "unknown".
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
    async run<T>(
      input: Omit<AuditEntryInput, "outcome" | "phase">,
      fn: () => Promise<T>,
      describe?: (result: T) => AuditRunResult
    ): Promise<T> {
      const startedId = await write({ ...input, phase: "started" });
      let result: T;
      try {
        result = await fn();
      } catch (err) {
        await writeOutcome({ ...input, phase: "outcome", outcome: "failed", reason: errorMessage(err), parentId: startedId });
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
        parentId: startedId,
      });
      return result;
    },
  };
}
