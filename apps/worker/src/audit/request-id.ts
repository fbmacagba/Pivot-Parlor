import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../bindings.js";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

/**
 * Server-generated request id only (Plan ruling 6). audit_log.request_id is
 * hashed into entry_hash and locked by the audit_log trigger for 6 years, so
 * it must be a value this worker controls — an inbound X-Request-Id header
 * is ignored, never trusted, never echoed back.
 */
export const requestId: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const id = crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};
