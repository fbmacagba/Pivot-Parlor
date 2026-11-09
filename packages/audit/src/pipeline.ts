import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { createAuditRecorder, type AuditRecorder } from "./recorder";

/** Only a user subject may be carried as who clicked Regenerate. Returned untouched when valid. */
const ORIGIN_REF = /^subj_user_[A-Za-z0-9-]{1,128}$/;

export function originActorRef(x: unknown): string | null {
  return typeof x === "string" && ORIGIN_REF.test(x) ? x : null;
}

/** A recorder for a queue consumer: a system actor, the job id as request id. */
export function queueAudit(db: D1Database, worker: string, jobId: string | null): AuditRecorder {
  return createAuditRecorder({ db, worker, via: "queue", actor: { type: "system" }, requestId: jobId });
}

export interface AiCallMeasure {
  model: string;
  route: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costBasis: string | null;
}

const round6 = (n: number | null): number | null => (n === null ? null : Math.round(n * 1e6) / 1e6);

/**
 * One model or image call as a two-step `ai.call` entry. The call never runs
 * if the started row cannot be written; its error is recorded structurally by
 * the recorder (name and HTTP status, never the message) and rethrown unchanged.
 */
export function auditAiCall<T>(
  rec: AuditRecorder,
  meta: { purpose: string; model: string; shopId: string | null; origin: string | null },
  fn: () => Promise<T>,
  measure: (r: T) => AiCallMeasure
): Promise<T> {
  const origin_actor_ref = originActorRef(meta.origin);
  return rec.run(
    {
      action: "ai.call",
      shopId: meta.shopId,
      entityType: "shop",
      entityId: meta.shopId,
      details: { purpose: meta.purpose, model: meta.model, origin_actor_ref },
    },
    fn,
    (r) => {
      let m: AiCallMeasure;
      try {
        m = measure(r);
      } catch {
        // The call already ran and was paid for: record that, never the thrown message.
        return { details: { purpose: meta.purpose, model: meta.model, origin_actor_ref, measure_failed: true } };
      }
      return {
        details: {
          purpose: meta.purpose,
          model: m.model,
          route: m.route,
          input_tokens: m.inputTokens,
          output_tokens: m.outputTokens,
          estimated_cost_usd: round6(m.costUsd),
          cost_basis: m.costBasis,
          origin_actor_ref,
        },
      };
    }
  );
}

/** A deterministic UUID-shaped id, so a redelivered completion collides on the primary key. */
export async function completionEntryId(jobId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`site.regenerate.complete:${jobId}`));
  const hex = Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface FinishJob {
  jobId: string;
  shopId: string;
  status: "complete" | "failed";
  stage: string;
  /** Free text for generation_jobs.error ONLY. Never enters the audit entry. */
  error: string | null;
  /** Fixed snake_case code for the audit entry's reason (e.g. audit_refused, no_valid_spec, crash). */
  reason: string | null;
  origin: string | null;
  details?: Record<string, unknown>;
  changes?: Record<string, [unknown, unknown]> | null;
}

/** The terminal job write: a no-op on a job that is already complete or failed. */
const TERMINAL_JOB_SQL =
  "UPDATE generation_jobs SET status = ?, stage = ?, error = ?, updated_at = ? WHERE id = ? AND COALESCE(status, 'queued') NOT IN ('complete', 'failed')";

/**
 * The Ruling 5 fallback every queue worker runs when `finishJob` cannot write
 * the completion entry: the job must still end. Same guard as the terminal
 * write, so it never overwrites a finished job. Binds: stage, error, updated_at, id.
 */
export const FAILED_JOB_FALLBACK_SQL =
  "UPDATE generation_jobs SET status = 'failed', stage = ?, error = ?, updated_at = ? WHERE id = ? AND COALESCE(status, 'queued') NOT IN ('complete', 'failed')";

export async function finishJobStatements(
  db: D1Database,
  rec: AuditRecorder,
  job: FinishJob
): Promise<D1PreparedStatement[]> {
  const update = db.prepare(TERMINAL_JOB_SQL).bind(job.status, job.stage, job.error, new Date().toISOString(), job.jobId);
  const entry = await rec.statements({
    id: await completionEntryId(job.jobId),
    action: "site.regenerate.complete",
    outcome: job.status === "complete" ? "succeeded" : "failed",
    reason: job.reason,
    shopId: job.shopId,
    entityType: "shop",
    entityId: job.shopId,
    changes: job.changes ?? null,
    // Caller details first: the authoritative keys always win.
    details: {
      ...job.details,
      job_id: job.jobId,
      stage: job.stage,
      result: job.status,
      origin_actor_ref: originActorRef(job.origin),
    },
  });
  return [update, ...entry];
}

/**
 * End a job with exactly one completion entry, in the same batch as the job's
 * terminal write. If the batch fails because an earlier delivery already
 * finished the job, that is success; any other failure rethrows.
 */
export async function finishJob(
  db: D1Database,
  rec: AuditRecorder,
  job: FinishJob,
  extra: D1PreparedStatement[] = []
): Promise<"finished" | "already_finished"> {
  const statements = await finishJobStatements(db, rec, job);
  try {
    await db.batch([...extra, ...statements]);
    return "finished";
  } catch (err) {
    const row = await db
      .prepare("SELECT status FROM generation_jobs WHERE id = ?")
      .bind(job.jobId)
      .first<{ status: string | null }>();
    if (row?.status === "complete" || row?.status === "failed") return "already_finished";
    throw err;
  }
}
