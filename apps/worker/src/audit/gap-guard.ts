import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { Via } from "@repo/audit";
import type { Bindings } from "../bindings.js";
import { getShopIdByIdOrSlug } from "../db/queries.js";
import { auditFor } from "./context.js";
import { ROUTE_AUDIT, type AuditDeclaration } from "./registry.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Ruling 55: the shape a shop id or slug can take (slugs are [a-z0-9-] from
 *  toSlug; ids are hex/uuid-like). Anything else is never looked up. */
const SHOP_PARAM_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** The responding route's path, or (index -1) the last matched route's. A
 *  thrown read means no route matched; it never breaks the guard. */
function readRoutePath(c: Context, index?: number): string {
  try {
    return routePath(c, index);
  } catch {
    return "";
  }
}

/**
 * The request's registry declaration. The responding route is tried first,
 * then the last matched route: when router-level middleware answers (a
 * `.use("*", requireShopRole(...))` refusal), the responding route is that
 * middleware's "/prefix/*", and only the last match is the handler that
 * carries the declaration. Each is tried as "METHOD route", then "ALL route".
 */
function declarationFor(
  c: Context,
  registry: Record<string, AuditDeclaration>
): AuditDeclaration | undefined {
  for (const candidate of [readRoutePath(c), readRoutePath(c, -1)]) {
    if (!candidate || candidate === "*") continue;
    for (const key of [`${c.req.method} ${candidate}`, `ALL ${candidate}`]) {
      if (Object.hasOwn(registry, key)) return registry[key];
    }
  }
  return undefined;
}

/**
 * Floor entry for any state-changing request that finished without writing
 * its own audit entry (Plan 1 decision 2). Best effort, written after the
 * response is built; the instrumented routes are the real guarantee.
 *
 * A factory, not a single middleware (Plan ruling 10): `via` records which
 * app observed the request — "api" for the main app, "webhook" for the
 * isolated `stripeWebhookApp`.
 *
 * It reads the coverage registry (Plan 2 decision 2). For a route declared
 * with a catalogue action and no entry of its own: a 4xx writes nothing
 * (nothing changed; refusals are stage 3), a 5xx writes the declared action
 * as failed, and a 2xx/3xx is still an audit.gap (a coverage bug). An exempt
 * route writes nothing. Pending and undeclared routes write an audit.gap.
 */
export function auditGapGuard(
  via: Via,
  registry: Record<string, AuditDeclaration> = ROUTE_AUDIT
): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    await next();
    if (!MUTATING.has(c.req.method) || c.get("auditWritten")) return;
    const status = c.res.status;
    if (status === 404 || status === 405 || status === 429) return;
    const outcome = status >= 500 ? "failed" : status >= 400 ? "refused" : "succeeded";

    const declaration = declarationFor(c, registry);
    if (typeof declaration === "object") return;
    const action = declaration !== undefined && declaration !== "pending" ? declaration : null;
    if (action && status >= 400 && status < 500) return;

    // Never record the concrete path (Plan ruling 11): only the matched
    // ROUTE PATTERN, e.g. "/api/invites/:token/accept" — a raw path can
    // carry tokens, ids or other caller-supplied values that don't belong
    // in a permanent, hashed audit column. Fall back to "unmatched" whenever
    // no reliable pattern can be read.
    let route = "unmatched";
    const matched = readRoutePath(c);
    if (matched && matched !== "*") route = matched;
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

    const details = { method: c.req.method, route, status, ...(shopParam ? { shop_param: shopParam } : {}) };
    try {
      if (action && status >= 500) {
        await auditFor(c, via).write({ action, outcome: "failed", reason: `HTTP ${status}`, shopId, details });
      } else {
        await auditFor(c, via).write({ action: "audit.gap", outcome, shopId, details });
      }
    } catch (err) {
      console.error("[audit] gap entry could not be written", c.req.method, route, err);
    }
  };
}
