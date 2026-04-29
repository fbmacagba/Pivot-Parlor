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

function extractSessionJwt(headers: { get(name: string): string | null }): string | null {
  const authHeader = headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const t = authHeader.slice(7).trim();
    return t || null;
  }
  const cookie = headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "pp_session") {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Extracts and verifies the JWT from Authorization: Bearer or pp_session cookie.
 * Attaches the decoded payload to c.get('user').
 */
export const authMiddleware: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const token = extractSessionJwt(c.req.raw.headers);
  if (!token) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

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
