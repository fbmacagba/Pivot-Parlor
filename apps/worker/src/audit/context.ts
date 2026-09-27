import type { Context } from "hono";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  AuditWriteError,
  createAuditRecorder,
  type ActorType,
  type AuditActor,
  type AuditEntryInput,
  type AuditRecorder,
  type Via,
} from "@repo/audit";
import type { Bindings } from "../bindings.js";
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

export function actorFrom(c: Ctx): AuditActor {
  const user = c.get("user") as JWTUser | undefined;
  const ip = c.req.header("CF-Connecting-IP") ?? null;
  if (!user) return { type: "anonymous", ip };
  return {
    type: ROLE_TO_ACTOR[user.role] ?? "anonymous",
    userId: user.sub,
    role: user.role,
    shopId: user.shop_id ?? null,
    ip,
  };
}

export function auditFor(c: Ctx, via: Via = "api"): AuditRecorder {
  return createAuditRecorder({
    db: c.env.DB,
    worker: WORKER_NAME,
    via,
    actor: actorFrom(c),
    requestId: c.get("requestId") ?? null,
    onWrite: () => c.set("auditWritten", true),
  });
}

export function systemAudit(db: D1Database, via: Via, requestId: string | null = null): AuditRecorder {
  return createAuditRecorder({ db, worker: WORKER_NAME, via, actor: { type: "system" }, requestId });
}

export function auditRefused(c: Ctx): Response {
  return c.json({ success: false, error: AUDIT_REFUSED_MESSAGE }, 503);
}

/** Commit `changes` and the audit entry in ONE batch (all-or-nothing).
 *  Returns a 503 Response when the entry cannot be prepared, else null. */
export async function batchWithAudit(
  c: Ctx,
  changes: D1PreparedStatement[],
  input: AuditEntryInput
): Promise<Response | null> {
  let audit: D1PreparedStatement[];
  try {
    audit = await auditFor(c).statements(input);
  } catch (err) {
    if (err instanceof AuditWriteError) return auditRefused(c);
    throw err;
  }
  await c.env.DB.batch([...changes, ...audit]);
  return null;
}
