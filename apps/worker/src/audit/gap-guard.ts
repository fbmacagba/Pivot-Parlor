import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../bindings.js";
import { auditFor } from "./context.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Floor entry for any state-changing request that finished without writing
 * its own audit entry (Plan 1 decision 2). Best effort, written after the
 * response is built; the instrumented routes are the real guarantee.
 */
export const auditGapGuard: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  await next();
  if (!MUTATING.has(c.req.method) || c.get("auditWritten")) return;
  const status = c.res.status;
  if (status === 404 || status === 405 || status === 429) return;
  const outcome = status >= 500 ? "failed" : status >= 400 ? "refused" : "succeeded";
  try {
    await auditFor(c).write({
      action: "audit.gap",
      outcome,
      details: { method: c.req.method, path: c.req.path, status },
    });
  } catch (err) {
    console.error("[audit] gap entry could not be written", c.req.method, c.req.path, err);
  }
};
