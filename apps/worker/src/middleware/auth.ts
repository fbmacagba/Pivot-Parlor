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

export function extractSessionJwt(headers: { get(name: string): string | null }): string | null {
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
 * Verifies a session JWT: its signature and expiry, then that the session is
 * still live. Every issued token has a session:<token> KV record (login,
 * OAuth, invite-accept); logout deletes it, so a signed JWT without one is
 * revoked or was never issued by us.
 */
async function verifySessionToken(
  env: Bindings,
  token: string,
): Promise<{ user: JWTUser } | { error: string }> {
  let payload: JWTUser;
  try {
    payload = (await verify(token, env.JWT_SECRET, "HS256")) as unknown as JWTUser;
  } catch {
    return { error: "Invalid or expired token" };
  }
  if ((await env.KV.get(`session:${token}`)) === null) {
    return { error: "Session expired or revoked" };
  }
  return { user: payload };
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

  const session = await verifySessionToken(c.env, token);
  if ("error" in session) {
    return c.json({ success: false, error: session.error }, 401);
  }

  c.set("user", session.user);
  await next();
};

/**
 * The signed-in user on a PUBLIC route, or null for anyone else. Same checks
 * as authMiddleware; a missing, forged, expired or revoked session is simply
 * the public, never a refusal.
 */
export async function optionalSessionUser(c: { env: Bindings; req: { raw: Request } }): Promise<JWTUser | null> {
  const token = extractSessionJwt(c.req.raw.headers);
  if (!token) return null;
  const session = await verifySessionToken(c.env, token);
  return "error" in session ? null : session.user;
}

export function getUser(c: Parameters<MiddlewareHandler>[0]): JWTUser {
  return c.get("user") as JWTUser;
}
