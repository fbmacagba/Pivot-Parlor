import type { MiddlewareHandler } from "hono";
import type { Env } from "../types.js";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

/**
 * Server-generated request id only (Plan 1 ruling 6, Plan 3 decision 2).
 * audit_log.request_id is hashed into entry_hash and locked for 6 years, so
 * it must be a value this worker controls. An inbound X-Request-Id header is
 * ignored, never trusted, never echoed back: a service-binding call from the
 * API cannot be told apart from a public workers.dev call.
 */
export const requestId: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const id = crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};
