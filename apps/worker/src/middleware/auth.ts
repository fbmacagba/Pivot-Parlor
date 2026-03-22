import { verify } from "hono/jwt";
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../bindings.js";

export interface JWTUser {
  sub: string;          // platform_users.id
  role: string;         // developer | admin | staff | customer
  shop_id?: string;
  shop_slug?: string;
  exp: number;
}

declare module "hono" {
  interface ContextVariableMap {
    user: JWTUser;
  }
}

/**
 * Extracts and verifies the Bearer JWT from Authorization header.
 * Attaches the decoded payload to c.get('user').
 */
export const authMiddleware: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verify(token, c.env.JWT_SECRET, "HS256") as unknown as JWTUser;
    c.set("user", payload);
    await next();
  } catch {
    return c.json({ success: false, error: "Invalid or expired token" }, 401);
  }
};

export function getUser(c: Parameters<MiddlewareHandler>[0]): JWTUser {
  return c.get("user") as JWTUser;
}
