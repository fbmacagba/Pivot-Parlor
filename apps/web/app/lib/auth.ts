import { redirect } from "@remix-run/cloudflare";
import type { UserRole } from "@repo/types";
import { createApiClient } from "~/lib/api";

export interface SessionPayload {
  sub: string;
  role: UserRole;
  shop_id?: string;
  shop_slug?: string;
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
  if (!token) {
    const url = new URL(request.url);
    throw redirect(`/login?redirect=${encodeURIComponent(url.pathname)}`);
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
    }>("/auth/me");

    const decoded = decodeToken(token);
    const exp = decoded?.exp ?? Math.floor(Date.now() / 1000) + 60 * 60;

    return {
      sub: me.id,
      role: me.role as UserRole,
      shop_id: me.shop_id ?? undefined,
      exp,
    };
  } catch {
    throw redirect("/login");
  }
}

/** Require a specific role. Throws a redirect if role doesn't match. */
export async function requireRole(
  request: Request,
  role: UserRole,
  apiUrl: string
): Promise<SessionPayload> {
  const payload = await requireAuth(request, apiUrl);
  if (payload.role !== role) {
    // Redirect to the user's correct dashboard, not root
    const dashMap: Record<UserRole, string> = {
      developer: "/dev/dashboard",
      admin: "/admin",
      staff: "/staff",
      customer: "/account",
    };
    throw redirect(dashMap[payload.role] ?? "/login");
  }
  return payload;
}

/** Build a Set-Cookie header to store the JWT. */
export function buildSessionCookie(token: string, isProd = false): string {
  const maxAge = 60 * 60 * 24 * 7; // 7 days
  return `pp_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Max-Age=${maxAge}; SameSite=Lax${isProd ? "; Secure" : ""}`;
}

/** Build a Set-Cookie header to clear the session. */
export function clearSessionCookie(): string {
  return "pp_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax";
}
