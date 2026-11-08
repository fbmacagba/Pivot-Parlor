import type { Context } from "hono";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  AuditWriteError,
  createAuditRecorder,
  type ActorType,
  type AuditActor,
  type AuditEntryInput,
  type AuditRecorder,
  type AuditRunResult,
  type Via,
} from "@repo/audit";
import type { Bindings } from "../bindings.js";
import { getShopById } from "../db/queries.js";
import type { JWTUser } from "../middleware/auth.js";

declare module "hono" {
  interface ContextVariableMap {
    auditWritten: boolean;
  }
}

export const WORKER_NAME = "pivot-parlor-api";
export const AUDIT_REFUSED_MESSAGE = "Could not record this action; nothing was changed.";

const ROLE_TO_ACTOR: Record<string, ActorType> = {
  developer: "developer",
  admin: "admin",
  staff: "staff",
  customer: "customer",
};

type Ctx = Context<{ Bindings: Bindings }>;

/** The platform itself: crons, the queue consumer, and system-driven steps. */
export const SYSTEM_ACTOR: AuditActor = Object.freeze({ type: "system" as const });

/** The actor for a known user, for routes where no session is on the context
 *  yet (a sign-in, a registration, an invite acceptance). */
export function actorForUser(user: { id: string; role: string; shop_id?: string | null }, ip: string | null): AuditActor {
  return {
    type: ROLE_TO_ACTOR[user.role] ?? "anonymous",
    userId: user.id,
    role: user.role,
    shopId: user.shop_id ?? null,
    ip,
  };
}

/** The caller's IP for an actor's visitor subject, or null when the edge sent
 *  none (never a placeholder such as rate-limit's "unknown"). */
export function requestIp(c: Ctx): string | null {
  return c.req.header("CF-Connecting-IP") ?? null;
}

export function actorFrom(c: Ctx): AuditActor {
  const user = c.get("user") as JWTUser | undefined;
  const ip = requestIp(c);
  if (!user) return { type: "anonymous", ip };
  return actorForUser({ id: user.sub, role: user.role, shop_id: user.shop_id }, ip);
}

/** A recorder for this request. `actor`, when given, replaces the one read
 *  from the session; `auditWritten` is still set once an entry commits. */
export function auditFor(c: Ctx, via: Via = "api", actor?: AuditActor): AuditRecorder {
  return createAuditRecorder({
    db: c.env.DB,
    worker: WORKER_NAME,
    via,
    actor: actor ?? actorFrom(c),
    requestId: c.get("requestId") ?? null,
    onWrite: () => c.set("auditWritten", true),
  });
}

export function systemAudit(db: D1Database, via: Via, requestId: string | null = null): AuditRecorder {
  return createAuditRecorder({ db, worker: WORKER_NAME, via, actor: SYSTEM_ACTOR, requestId });
}

/** `run()` outcome from the handler's Response, the same split the gap guard
 *  uses: below 400 succeeded, 4xx refused, 5xx failed, with `HTTP <status>`
 *  as the reason from 400 up. `extra(res)` merges over the result. */
export function statusOutcome(
  extra?: (res: Response) => Partial<AuditRunResult>
): (res: Response) => AuditRunResult {
  return (res) => {
    const status = res.status;
    return {
      outcome: status >= 500 ? "failed" : status >= 400 ? "refused" : "succeeded",
      reason: status >= 400 ? `HTTP ${status}` : null,
      ...extra?.(res),
    };
  };
}

/** `details.shop_param` for an entry whose `:shopId` param named no shop. */
export const UNRESOLVED_SHOP = Object.freeze({ shop_param: "unresolved" as const });

/**
 * For an entry only: the shop a `:shopId` URL param names, as its DB id, or
 * null when no shop has that id. `requireShopRole` lets developers through
 * without checking the shop, so the raw param is caller text and must never
 * reach `shop_id` or `entity_id` (hashed, locked for 6 years). Where this
 * returns null, record `shopId: null` plus `UNRESOLVED_SHOP` in details.
 * The handler's own reads and writes keep using the param, so no response
 * changes.
 */
export async function auditShopId(c: Ctx, param: string): Promise<string | null> {
  return (await getShopById(c.env.DB, param))?.id ?? null;
}

export function auditRefused(c: Ctx): Response {
  return c.json({ success: false, error: AUDIT_REFUSED_MESSAGE }, 503);
}

/** Commit `changes` and the audit entry in ONE batch (all-or-nothing).
 *  Returns a 503 Response when the entry cannot be prepared, else null.
 *  A batch (commit) failure is NOT caught here — it propagates as the
 *  original error, since the caller's whole operation failed, not merely
 *  the audit write (Plan ruling 9). `auditWritten` only becomes true once
 *  this batch actually commits (Plan ruling 8). */
export async function batchWithAudit(
  c: Ctx,
  changes: D1PreparedStatement[],
  input: AuditEntryInput,
  opts?: { via?: Via; actor?: AuditActor }
): Promise<Response | null> {
  try {
    await auditFor(c, opts?.via, opts?.actor).batch(changes, input);
  } catch (err) {
    if (err instanceof AuditWriteError) return auditRefused(c);
    throw err;
  }
  return null;
}
