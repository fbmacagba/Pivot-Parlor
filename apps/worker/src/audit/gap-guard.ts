import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { Via } from "@repo/audit";
import type { Bindings } from "../bindings.js";
import { getShopIdByIdOrSlug } from "../db/queries.js";
import { auditFor } from "./context.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Ruling 55: the shape a shop id or slug can take (slugs are [a-z0-9-] from
 *  toSlug; ids are hex/uuid-like). Anything else is never looked up. */
const SHOP_PARAM_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Floor entry for any state-changing request that finished without writing
 * its own audit entry (Plan 1 decision 2). Best effort, written after the
 * response is built; the instrumented routes are the real guarantee.
 *
 * A factory, not a single middleware (Plan ruling 10): `via` records which
 * app observed the request — "api" for the main app, "webhook" for the
 * isolated `stripeWebhookApp`.
 */
export function auditGapGuard(via: Via): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    await next();
    if (!MUTATING.has(c.req.method) || c.get("auditWritten")) return;
    const status = c.res.status;
    if (status === 404 || status === 405 || status === 429) return;
    const outcome = status >= 500 ? "failed" : status >= 400 ? "refused" : "succeeded";

    // Never record the concrete path (Plan ruling 11): only the matched
    // ROUTE PATTERN, e.g. "/api/invites/:token/accept" — a raw path can
    // carry tokens, ids or other caller-supplied values that don't belong
    // in a permanent, hashed audit column. Fall back to "unmatched" whenever
    // no reliable pattern can be read.
    let route = "unmatched";
    try {
      const matched = routePath(c);
      if (matched && matched !== "*") route = matched;
    } catch {
      // No route ever matched — keep "unmatched" rather than guessing.
    }
    // Ruling 55: :shopId is caller-supplied (any string an unauthenticated
    // request puts in the path), and shop_id is hashed into a 6-year entry.
    // Record it only once it resolves to an existing shop (an id, or a slug
    // resolved to its id); otherwise record null and say so.
    let shopId: string | null = null;
    let shopParam: "unresolved" | undefined;
    if (route.includes(":shopId")) {
      const param = c.req.param("shopId");
      if (param && SHOP_PARAM_SHAPE.test(param)) {
        try {
          shopId = await getShopIdByIdOrSlug(c.env.DB, param);
        } catch (err) {
          // A failed lookup must not cost the gap entry itself.
          console.error("[audit] gap guard shop lookup failed", err instanceof Error ? err.name : err);
        }
      }
      if (!shopId) shopParam = "unresolved";
    }

    try {
      await auditFor(c, via).write({
        action: "audit.gap",
        outcome,
        shopId,
        details: { method: c.req.method, route, status, ...(shopParam ? { shop_param: shopParam } : {}) },
      });
    } catch (err) {
      console.error("[audit] gap entry could not be written", c.req.method, route, err);
    }
  };
}
