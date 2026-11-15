/**
 * Server-side Turnstile check (Cloudflare siteverify).
 *
 * A token can be redeemed only once: a second check of the same token fails
 * with `timeout-or-duplicate`. So each form's token is checked in exactly one
 * place. For the marketing contact form that is the API, which a bot posting
 * straight to it cannot skip; the website only forwards the token.
 */

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The longest token Turnstile issues. */
export const TURNSTILE_TOKEN_MAX = 2048;

/** How long to wait for siteverify before treating it as unreachable. */
const SITEVERIFY_TIMEOUT_MS = 5000;

/**
 * - `passed`: siteverify accepted the token.
 * - `rejected`: the token is missing, bad, expired or already used. The visitor's to retry.
 * - `misconfigured`: siteverify refused our secret. Ours to fix.
 * - `unavailable`: siteverify could not be reached or did not answer properly.
 */
export type TurnstileOutcome =
  | { result: "passed" }
  | { result: "rejected" | "misconfigured" | "unavailable"; codes: string[] };

const SECRET_ERRORS = new Set(["missing-input-secret", "invalid-input-secret"]);

/** The token as sent, or null when it is not a plausible Turnstile token. */
export function readTurnstileToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return token && token.length <= TURNSTILE_TOKEN_MAX ? token : null;
}

/** Asks siteverify about `token`. Never throws. */
export async function verifyTurnstileToken(
  secret: string,
  token: string,
  remoteIp: string | null,
): Promise<TurnstileOutcome> {
  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp && remoteIp !== "unknown") form.set("remoteip", remoteIp);
  let answer: { success?: unknown; "error-codes"?: unknown };
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return { result: "unavailable", codes: [`http-${res.status}`] };
    answer = (await res.json()) as typeof answer;
  } catch {
    return { result: "unavailable", codes: ["unreachable"] };
  }
  if (answer.success === true) return { result: "passed" };
  const codes = Array.isArray(answer["error-codes"]) ? answer["error-codes"].map(String) : [];
  if (codes.some((code) => SECRET_ERRORS.has(code))) return { result: "misconfigured", codes };
  if (codes.includes("internal-error")) return { result: "unavailable", codes };
  return { result: "rejected", codes };
}
