import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../bindings.js";
import { getUser } from "./auth.js";

/**
 * Requires the authenticated user to have one of the given roles.
 * Must be used after authMiddleware.
 */
export function requireRole(...roles: string[]): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const user = getUser(c);
    if (!user || !roles.includes(user.role)) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }
    await next();
  };
}

// NOTE: the old role-agnostic requireShop() was deleted (WS-7) — it had no
// call sites and let any shop-bound user through regardless of role, which is
// exactly the SEC-2 shape we fixed. Use requireShopRole(...) instead.

/**
 * Requires the authenticated user to EITHER be a developer (platform access),
 * OR hold one of the given roles AND own the shop in the :shopId param.
 *
 * Use it to keep shop-scoped mutations admin-only (requireShopRole("admin"))
 * while allowing staff onto operational routes (requireShopRole("admin", "staff")).
 * Must be used after authMiddleware.
 */
export function requireShopRole(...roles: string[]): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const user = getUser(c);
    if (!user) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    if (user.role === "developer") {
      await next();
      return;
    }
    const shopId = c.req.param("shopId");
    if (!shopId || user.shop_id !== shopId || !roles.includes(user.role)) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }
    await next();
  };
}
