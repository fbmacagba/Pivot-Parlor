# Phase 4 Implementation Plan — Session & OAuth Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make logout actually revoke sessions, close the OAuth open redirect, make OAuth state CSRF-resistant, rate-limit abusable endpoints, and add security headers to the API.

**Architecture:** Branch `remediation/phase-4` stacked on `remediation/phase-3`. New `src/middleware/rate-limit.ts` and `src/lib/oauth-state.ts`; surgical changes to `middleware/auth.ts`, `routes/{auth,oauth,invites,ai,contact,bookings}.ts`, `index.ts`.

**Survey results baked in:**
- Token issuance points: login ✓KV, oauth `issueToken` ✓KV, **invite-accept (invites.ts:128) does NOT write KV** — must fix with T4.1 or invite logins break.
- Logout only revokes `Authorization`-header tokens; cookie sessions no-op — fix with shared `extractSessionJwt`.
- Web `_headers` already comprehensive (CSP, HSTS, XFO) — T4.5 is worker-API only; use hono's `secureHeaders`.
- State validation must run BEFORE the external token exchange so invalid-state tests need no fetch mocking.

### Task 1: Session revocation (T4.1)

- [ ] `middleware/auth.ts`: export `extractSessionJwt`; after `verify`, `const live = await c.env.KV.get("session:"+token); if (live === null) return 401 "Session expired or revoked"`.
- [ ] `routes/invites.ts:128`: add the same `KV.put("session:"+jwt, …, { expirationTtl })` as login.
- [ ] `routes/auth.ts` logout: use `extractSessionJwt(c.req.raw.headers)` so cookie logouts revoke too.
- [ ] Tests: valid-token-no-KV → 401; login→logout(header & cookie)→reuse → 401; invite-accept token passes middleware.

### Task 2: OAuth state + redirect (T4.2, T4.3, T4.6)

- [ ] New `src/lib/oauth-state.ts`:

```ts
const MAX_STATE_AGE_MS = 10 * 60 * 1000;

export function buildState(redirectTo: string, nonce: string): string {
  return btoa(JSON.stringify({ redirectTo, nonce, ts: Date.now() }));
}

export function validateState(
  state: string,
  cookieNonce: string | undefined,
  now: number
): { ok: true; redirectTo: string } | { ok: false; reason: string } {
  let parsed: { redirectTo?: string; nonce?: string; ts?: number };
  try {
    parsed = JSON.parse(atob(state));
  } catch {
    return { ok: false, reason: "malformed state" };
  }
  if (!parsed.nonce || !parsed.ts) return { ok: false, reason: "incomplete state" };
  if (now - parsed.ts > MAX_STATE_AGE_MS) return { ok: false, reason: "state expired" };
  if (!cookieNonce || cookieNonce !== parsed.nonce) return { ok: false, reason: "state nonce mismatch" };
  return { ok: true, redirectTo: safeRedirect(parsed.redirectTo) };
}

/** Only same-origin relative paths; anything else falls back to "/". */
export function safeRedirect(path: string | undefined): string {
  if (!path) return "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/";
  return path;
}
```

- [ ] `routes/oauth.ts`: initiation routes mint `nonce = crypto.randomUUID()`, set `pp_oauth_nonce` cookie (HttpOnly, Max-Age=600, SameSite=Lax, Secure in prod, Path=/), build state with nonce. Callbacks validate state + cookie BEFORE token exchange (400 on failure), clear the nonce cookie, and use `safeRedirect`-derived dest (falls back to role dashboard when "/").
- [ ] T4.6: Google + LinkedIn userinfo include `email_verified`; reject `email_verified === false` with 403 (Facebook doesn't send the claim; its emails are platform-verified — documented).
- [ ] Tests: unit tests for `buildState`/`validateState`/`safeRedirect` (open-redirect vectors: `https://evil.com`, `//evil.com`, `/\\evil.com`, expired ts, nonce mismatch); route test: `GET /auth/google/callback?code=x&state=garbage` → 400 with no external fetch.

### Task 3: Rate limiting (T4.4)

- [ ] New `src/middleware/rate-limit.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../bindings.js";

interface RateLimitOpts {
  name: string;
  limit: number;
  windowS: number; // KV minimum TTL is 60
  key: (c: { req: { header(n: string): string | undefined; json?: unknown } }) => Promise<string | null> | string | null;
}

/** Fixed-window KV counter. Eventually consistent — an abuse brake, not a precise quota. */
export function rateLimit(opts: RateLimitOpts): MiddlewareHandler<{ Bindings: Bindings }> { ... }
```

- [ ] Apply: login 5/15min per email+IP; register 10/h per IP; `/api/ai/*` 10/h per user; contact POST 5/h per IP; public bookings POST 30/h per IP. IP from `CF-Connecting-IP` (fallback "unknown"). 429 with standard envelope + `Retry-After`.
- [ ] Tests: 6th bad login → 429; counters scoped per key (different email unaffected).

### Task 4: API security headers (T4.5)

- [ ] `index.ts`: `secureHeaders` from `hono/secure-headers` on the main app (not the Stripe webhook app): nosniff, XFO DENY, HSTS, no referrer leakage. Test asserts headers on a response.

### Task 5: Verify + ship

- [ ] Suite green, `tsc` 0 errors, root build passes; commit per task; push; stacked PR base `remediation/phase-3`.

## Self-review
T4.1✓(1) T4.2✓(2 safeRedirect) T4.3✓(2 nonce+expiry+cookie) T4.4✓(3) T4.5✓(4) T4.6✓(2). Invite-accept KV gap covered (would have broken logins). No placeholders except rateLimit body, completed at implementation with the documented semantics.
