import { verify } from "hono/jwt";
import type { MiddlewareHandler } from "hono";
import type { Env, JWTUser } from "../types.js";

declare module "hono" {
  interface ContextVariableMap {
    user: JWTUser;
  }
}

export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  const token = authHeader.slice(7);
  try {
    const payload = (await verify(token, c.env.JWT_SECRET, "HS256")) as unknown as JWTUser;
    c.set("user", payload);
    await next();
  } catch {
    return c.json({ success: false, error: "Invalid or expired token" }, 401);
  }
};

export function getUser(c: { get: (k: "user") => JWTUser }): JWTUser {
  return c.get("user");
}
