import { redirect } from "react-router";
import type { UserRole } from "@repo/types";
import { apiErrorStatus, createApiClient } from "~/lib/api";

export interface SessionPayload {
  sub: string;
  role: UserRole;
  shop_id?: string;
  shop_slug?: string;
  /** The person's own name, for the dashboard shell (never the id). */
  name?: string;
  /** Their shop's name (admins and staff). */
  shop_name?: string;
  exp: number;
}

function base64UrlToBase64(b64url: string): string {
  return b64url.replace(/-/g, "+").replace(/_/g, "/");
}

function addBase64Padding(b64: string): string {
  // atob requires padded base64.
  const padLen = (4 - (b64.length % 4)) % 4;
  return padLen ? `${b64}${"=".repeat(padLen)}` : b64;
}

function decodeBase64UrlString(b64url: string): string {
  return atob(addBase64Padding(base64UrlToBase64(b64url)));
}

function decodeBase64UrlToBytes(b64url: string): Uint8Array {
  const bin = decodeBase64UrlString(b64url);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Extract the raw JWT string from the pp_session cookie. */
export function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "pp_session") return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Verify a JWT using Web Crypto (HMAC-SHA256). Returns the payload. */
export async function verifyToken(
  token: string,
  secret: string
): Promise<SessionPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");

  const [headerB64, payloadB64, sigB64] = parts;
  const data = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const sig = decodeBase64UrlToBytes(sigB64);

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sig as BufferSource,
    new TextEncoder().encode(data)
  );

  if (!valid) throw new Error("Invalid signature");

  const payload = JSON.parse(decodeBase64UrlString(payloadB64)) as SessionPayload;

  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error("Token expired");
  }

  return payload;
}

/** Decode payload WITHOUT verifying the signature (for client-side display). */
export function decodeToken(token: string): SessionPayload | null {
  try {
    const [, payloadB64] = token.split(".");
    return JSON.parse(decodeBase64UrlString(payloadB64)) as SessionPayload;
  } catch {
    return null;
  }
}

/** Require authentication. Redirects to `/login` when unauthenticated or session invalid. */
export async function requireAuth(
  request: Request,
  apiUrl: string
): Promise<SessionPayload> {
  const token = getSessionToken(request);
  const url = new URL(request.url);
  // Where to come back to after signing in: the page asked for, query included
  // (a developer's ?shopId=, a list's filters).
  const loginUrl = `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`;
  if (!token) {
    throw redirect(loginUrl);
  }

  try {
    // Delegate JWT signature + expiry verification to the Worker.
    // This avoids any web-side token verification mismatches and keeps the
    // trust boundary at the API where JWT_SECRET is configured.
    const api = createApiClient(apiUrl, token);
    const me = await api.get<{
      id: string;
      role: string;
      shop_id: string | null;
      name?: string | null;
      shop_name?: string | null;
    }>("/auth/me");

    const decoded = decodeToken(token);
    const exp = decoded?.exp ?? Math.floor(Date.now() / 1000) + 60 * 60;

    return {
      sub: me.id,
      role: me.role as UserRole,
      shop_id: me.shop_id ?? undefined,
      name: me.name?.trim() || undefined,
      shop_name: me.shop_name?.trim() || undefined,
      exp,
    };
  } catch (error) {
    // Only a refused session sends the visitor to sign in. When the API itself
    // is failing, signing in again cannot help: answer 503 so the page's error
    // screen says "try again in a moment" and the session is left alone.
    const status = apiErrorStatus(error);
    if (status === 401 || status === 403 || status === 404) throw redirect(loginUrl);
    throw new Response(null, { status: 503, statusText: "Service unavailable" });
  }
}

/**
 * Require a specific role. Throws a redirect if role doesn't match.
 * Developers pass every role check so they can open any dashboard for support.
 */
export async function requireRole(
  request: Request,
  role: UserRole,
  apiUrl: string
): Promise<SessionPayload> {
  const payload = await requireAuth(request, apiUrl);
  if (payload.role === "developer") {
    return payload;
  }
  if (payload.role !== role) {
    // Redirect to the user's correct dashboard. Fall back to "/" (not "/login")
    // for an unrecognised role so we never bounce into a /login redirect loop.
    const dashMap: Record<UserRole, string> = {
      developer: "/dev/dashboard",
      admin: "/admin",
      staff: "/staff",
      customer: "/account",
    };
    throw redirect(dashMap[payload.role] ?? "/");
  }
  return payload;
}

/** Build a Set-Cookie header to store the JWT. */
export function buildSessionCookie(token: string, isProd = false): string {
  const maxAge = 60 * 60 * 24 * 7; // 7 days
  const domain = isProd ? "; Domain=.pivotparlor.com" : "";
  return `pp_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Max-Age=${maxAge}; SameSite=Lax${isProd ? "; Secure" : ""}${domain}`;
}

/** Build a Set-Cookie header to clear the session. */
export function clearSessionCookie(isProd = false): string {
  const domain = isProd ? "; Domain=.pivotparlor.com" : "";
  return `pp_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax${isProd ? "; Secure" : ""}${domain}`;
}

/** Clear host-only `pp_session` on the current site origin (no Domain=). Use with domain-scoped cookie updates. */
export function clearHostOnlySessionCookie(isProd = false): string {
  return `pp_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax${isProd ? "; Secure" : ""}`;
}

/** Multiple Set-Cookie headers for a new session in production (avoid duplicate host-only + domain cookies). */
export function sessionCookieHeaders(token: string, isProd = false): Headers {
  const h = new Headers();
  if (isProd) {
    h.append("Set-Cookie", clearHostOnlySessionCookie(true));
  }
  h.append("Set-Cookie", buildSessionCookie(token, isProd));
  return h;
}
