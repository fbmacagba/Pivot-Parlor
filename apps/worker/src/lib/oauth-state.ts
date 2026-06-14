/**
 * OAuth state handling: nonce-bound (double-submit cookie) with a 10-minute
 * expiry, plus open-redirect-safe destination parsing.
 *
 * The initiation route mints a nonce, stores it in the short-lived HttpOnly
 * pp_oauth_nonce cookie, and embeds it in the state param. The callback only
 * proceeds when the state's nonce matches the cookie — a forged or replayed
 * callback link (CSRF) fails because the victim's browser lacks the cookie.
 */

const MAX_STATE_AGE_MS = 10 * 60 * 1000;

export const OAUTH_NONCE_COOKIE = "pp_oauth_nonce";

export function buildState(redirectTo: string, nonce: string): string {
  return btoa(JSON.stringify({ redirectTo, nonce, ts: Date.now() }));
}

export type StateValidation =
  | { ok: true; redirectTo: string }
  | { ok: false; reason: string };

export function validateState(
  state: string,
  cookieNonce: string | undefined,
  now: number
): StateValidation {
  let parsed: { redirectTo?: string; nonce?: string; ts?: number };
  try {
    parsed = JSON.parse(atob(state)) as { redirectTo?: string; nonce?: string; ts?: number };
  } catch {
    return { ok: false, reason: "malformed state" };
  }
  if (typeof parsed.nonce !== "string" || !parsed.nonce || typeof parsed.ts !== "number") {
    return { ok: false, reason: "incomplete state" };
  }
  if (now - parsed.ts > MAX_STATE_AGE_MS) {
    return { ok: false, reason: "state expired" };
  }
  if (!cookieNonce || cookieNonce !== parsed.nonce) {
    return { ok: false, reason: "state nonce mismatch" };
  }
  return { ok: true, redirectTo: safeRedirect(parsed.redirectTo) };
}

/** Only same-origin relative paths survive; anything else falls back to "/". */
export function safeRedirect(path: string | undefined): string {
  if (!path) return "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/";
  return path;
}

export function nonceCookie(nonce: string, isProd: boolean): string {
  return `${OAUTH_NONCE_COOKIE}=${nonce}; Path=/; HttpOnly; Max-Age=600; SameSite=Lax${isProd ? "; Secure" : ""}`;
}

export function clearNonceCookie(isProd: boolean): string {
  return `${OAUTH_NONCE_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax${isProd ? "; Secure" : ""}`;
}

export function readNonceCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === OAUTH_NONCE_COOKIE) return v.join("=") || undefined;
  }
  return undefined;
}
