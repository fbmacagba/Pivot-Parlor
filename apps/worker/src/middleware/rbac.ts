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

/**
 * Requires the authenticated user to own the shop (shop_id matches param)
 * OR to be a developer (platform-level access).
 * Must be used after authMiddleware.
 */
export function requireShop(): MiddlewareHandler<{ Bindings: Bindings }> {
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
    if (!shopId || user.shop_id !== shopId) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }
    await next();
  };
}

/**
 * Requires the authenticated user to EITHER be a developer (platform access),
 * OR hold one of the given roles AND own the shop in the :shopId param.
 *
 * This is the role-aware form of requireShop(): use it to keep shop-scoped
 * mutations admin-only (e.g. requireShopRole("admin")) while allowing staff
 * onto operational routes (requireShopRole("admin", "staff")). Plain
 * requireShop() is role-agnostic and lets any shop-bound user through.
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
