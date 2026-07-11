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
  let payload: JWTUser;
  try {
    payload = (await verify(token, c.env.JWT_SECRET, "HS256")) as unknown as JWTUser;
  } catch {
    return c.json({ success: false, error: "Invalid or expired token" }, 401);
  }

  // Server-side revocation (WS-7): every issued token has a session:<token>
  // record in the KV namespace shared with the main worker (login/OAuth/invite
  // write it, logout deletes it). Without this check a logged-out or revoked
  // token stayed valid ~7 days on the surface that moves money.
  const live = await c.env.KV.get(`session:${token}`);
  if (live === null) {
    return c.json({ success: false, error: "Session expired or revoked" }, 401);
  }

  c.set("user", payload);
  await next();
};

export function getUser(c: { get: (k: "user") => JWTUser }): JWTUser {
  return c.get("user");
}
