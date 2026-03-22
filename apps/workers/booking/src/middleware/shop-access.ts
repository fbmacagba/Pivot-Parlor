import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types.js";
import { getUser } from "./auth.js";

/** Developer: all shops. Admin/staff: must match JWT shop_id. */
export function requireShopAccess(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const shopId = c.req.param("shopId");
    if (!shopId) {
      return c.json({ success: false, error: "Missing shopId" }, 400);
    }
    const user = getUser(c);
    if (user.role === "developer") {
      await next();
      return;
    }
    if ((user.role === "admin" || user.role === "staff") && user.shop_id === shopId) {
      await next();
      return;
    }
    return c.json({ success: false, error: "Forbidden for this shop" }, 403);
  };
}

export function requireDeveloper(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = getUser(c);
    if (user.role !== "developer") {
      return c.json({ success: false, error: "Developer role required" }, 403);
    }
    await next();
  };
}

export async function shopExists(c: Context<{ Bindings: Env }>, shopId: string): Promise<boolean> {
  const row = await c.env.DB.prepare("SELECT 1 AS ok FROM shops WHERE id = ? LIMIT 1").bind(shopId).first<{ ok: number }>();
  return Boolean(row?.ok);
}
