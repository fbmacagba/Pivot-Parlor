import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes, routePath } from "hono/route";
import type { Via } from "@repo/audit";
import type { Env } from "../types.js";
import { auditFor, resolveShopParam } from "./context.js";
import { ROUTE_AUDIT, type AuditDeclaration } from "./registry.js";

export { resolveShopParam };

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The responding route's path, or (index -1) the last matched route's. A
 *  thrown read means no route matched; it never breaks the guard. */
function readRoutePath(c: Context, index?: number): string {
  try {
    return routePath(c, index);
  } catch {
    return "";
  }
}

/** Every matched route's path, last first. A thrown read means no route
 *  matched; it never breaks the guard. */
function matchedPathsLastFirst(c: Context): string[] {
  try {
    return matchedRoutes(c)
      .map((r) => r.path)
      .reverse();
  } catch {
    return [];
  }
}

/** The request's registry declaration: the responding route first, then
 *  every matched route from the last back (router-level middleware may
 *  answer, and a middleware registered after the handler may also match),
 *  each tried as "METHOD route" then "ALL route". */
function declarationFor(
  c: Context,
  registry: Record<string, AuditDeclaration>
): AuditDeclaration | undefined {
  for (const candidate of [readRoutePath(c), ...matchedPathsLastFirst(c)]) {
    if (!candidate || candidate === "*") continue;
    for (const key of [`${c.req.method} ${candidate}`, `ALL ${candidate}`]) {
      if (Object.hasOwn(registry, key)) return registry[key];
    }
  }
  return undefined;
}

/**
 * Floor entry for any state-changing request that finished without writing
 * its own audit entry. Same rules as the API worker's guard: a 4xx on a
 * declared route writes nothing, a 5xx writes the declared action as failed,
 * a 2xx/3xx on a declared route is still an audit.gap (a coverage bug), an
 * exempt route writes nothing, an undeclared route writes an audit.gap for
 * anything but a 4xx (a refusal changed nothing, and anonymous callers could
 * otherwise fill the append-only log: ledger 8927dfec), and a pending route
 * writes an audit.gap for every status. `via` is "webhook" under /webhooks/
 * and "api" otherwise.
 */
export function auditGapGuard(
  registry: Record<string, AuditDeclaration> = ROUTE_AUDIT
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    await next();
    if (!MUTATING.has(c.req.method) || c.get("auditWritten")) return;
    const status = c.res.status;
    if (status === 404 || status === 405 || status === 429) return;
    const outcome = status >= 500 ? "failed" : status >= 400 ? "refused" : "succeeded";

    const declaration = declarationFor(c, registry);
    if (typeof declaration === "object") return;
    if (declaration !== "pending" && status >= 400 && status < 500) return;
    const action = declaration !== undefined && declaration !== "pending" ? declaration : null;

    // Only the matched ROUTE PATTERN is recorded, never the concrete path.
    let route = "unmatched";
    const matched = readRoutePath(c);
    if (matched && matched !== "*") route = matched;

    // :shopId is caller-supplied; record it only once it resolves to a shop.
    let shopId: string | null = null;
    let shopParam: "unresolved" | undefined;
    if (route.includes(":shopId")) {
      const param = c.req.param("shopId");
      if (param) {
        try {
          shopId = await resolveShopParam(c.env.DB, param);
        } catch (err) {
          // A failed lookup must not cost the gap entry itself.
          console.error("[audit] gap guard shop lookup failed", err instanceof Error ? err.name : err);
        }
      }
      if (!shopId) shopParam = "unresolved";
    }

    const via: Via = c.req.path.startsWith("/webhooks/") ? "webhook" : "api";
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
