import { createAuditRecorder, type AuditActor, type AuditRecorder } from "@repo/audit";
import type { Env } from "./types.js";

export const WORKER_NAME = "pivot-parlor-chatbot";
export const AUDIT_REFUSED_MESSAGE = "Could not record this action; nothing was changed.";

/** The visitor behind a chat request. `ip` is the edge's CF-Connecting-IP, or
 *  null when absent (never a placeholder): the recorder makes a visitor
 *  subject only from a real IP. */
export function visitorActor(ip: string | null): AuditActor {
  return { type: "anonymous", ip };
}

/** A recorder for one chat request. `requestId` is also the id inside the
 *  `ai_usage_log` job_id, so the entry and the usage row correlate. */
export function auditFor(env: Pick<Env, "DB">, ip: string | null, requestId: string): AuditRecorder {
  return createAuditRecorder({ db: env.DB, worker: WORKER_NAME, via: "api", actor: visitorActor(ip), requestId });
}

/** Thrown inside the audited call when no model produced a reply. Fixed name,
 *  no visitor or model text, so the recorded failure reason carries neither. */
export class ChatReplyFailedError extends Error {
  constructor() {
    super("chat reply failed");
    this.name = "ChatReplyFailedError";
  }
}
