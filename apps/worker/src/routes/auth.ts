import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import type { Bindings } from "../bindings.js";
import { getUserByEmail, getUserById, createUser } from "../db/queries.js";
import { authMiddleware, extractSessionJwt, getUser, type JWTUser } from "../middleware/auth.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";
import { e2eMockAllowed } from "../lib/e2e.js";
import { hashPassword, verifyPassword, needsRehash } from "../lib/password.js";
import { sendVerificationEmail } from "../services/email.js";
import { reportError } from "../services/report-error.js";

const auth = new Hono<{ Bindings: Bindings }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SESSION_TTL_S = 60 * 60 * 24 * 7; // 7 days
const EMAIL_VERIFY_TTL_S = 60 * 60 * 24; // verification links live 24h

/**
 * Mint a verify-email token in KV and send the link (SEC-3). Non-fatal by
 * design: registration must not fail because Resend is down or unconfigured —
 * the user can request a resend later.
 */
async function issueEmailVerification(
  env: Bindings,
  userId: string,
  email: string,
  name: string | null
): Promise<boolean> {
  const token = crypto.randomUUID();
  await env.KV.put(`everify:${token}`, JSON.stringify({ user_id: userId }), {
    expirationTtl: EMAIL_VERIFY_TTL_S,
  });
  if (!env.RESEND_API_KEY) {
    console.warn("[auth] RESEND_API_KEY not set — verification email skipped");
    return false;
  }
  const verifyUrl = `${env.APP_URL ?? "https://pivotparlor.com"}/verify-email?token=${token}`;
  try {
    await sendVerificationEmail(env.RESEND_API_KEY, { to: email, name, verifyUrl });
    return true;
  } catch (err) {
    reportError("auth.verification_email", err, { userId });
    return false;
  }
}

// ─── POST /auth/login ─────────────────────────────────────────────────────────

// Brute-force brake: 5 attempts per email+IP per 15 minutes (NFR-S4).
// Hono caches parsed bodies, so reading it here doesn't consume the handler's read.
const loginRateLimit = rateLimit({
  name: "login",
  limit: 5,
  windowS: 900,
  key: async (c) => {
    const body = await c.req.json<{ email?: string }>().catch((): { email?: string } => ({}));
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "-";
    return `${email}:${clientIp(c)}`;
  },
});

// The E2E suite drives many logins from one IP and would trip the brute-force
// brake. Skip it ONLY for requests that both run on a fixtures-enabled env
// (E2E_FIXTURES=true, i.e. staging) AND carry the X-E2E-Test-Mock:1 header — so
// ordinary anonymous traffic to the staging URL stays fully rate-limited, and
// production (E2E_FIXTURES unset) always enforces the brake.
const loginRateLimitUnlessE2E = (c: Parameters<typeof loginRateLimit>[0], next: Parameters<typeof loginRateLimit>[1]) =>
  e2eMockAllowed(c.env, c.req.header("X-E2E-Test-Mock")) ? next() : loginRateLimit(c, next);

auth.post("/login", loginRateLimitUnlessE2E, async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  if (!body.email || !body.password) {
    return c.json({ success: false, error: "email and password are required" }, 400);
  }

  // NOTE: no first-login bootstrap here. The developer account must be seeded
  // deliberately (scripts/reset-dev-password.mjs) — auto-creating it on first
  // login let whoever tried the well-known email first claim the platform.
  const user = await getUserByEmail(c.env.DB, body.email);
  if (!user) return c.json({ success: false, error: "Invalid credentials" }, 401);

  const ok = await verifyPassword(body.password, user.password_hash);
  if (!ok) return c.json({ success: false, error: "Invalid credentials" }, 401);

  // Transparent KDF upgrade (WS-7): re-hash pre-v2 rows at the current cost on
  // the only moment we hold the plaintext. Best-effort — login must not fail
  // on it; the old hash keeps working until the next attempt.
  if (needsRehash(user.password_hash)) {
    try {
      const upgraded = await hashPassword(body.password);
      await c.env.DB
        .prepare("UPDATE platform_users SET password_hash = ? WHERE id = ?")
        .bind(upgraded, user.id)
        .run();
    } catch (err) {
      reportError("auth.kdf_rehash", err, { userId: user.id });
    }
  }

  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const payload = {
    sub: user.id,
    role: user.role,
    ...(user.shop_id ? { shop_id: user.shop_id } : {}),
    exp,
  };

  const token = await sign(payload, c.env.JWT_SECRET);

  // Store session in KV for instant revocation
  await c.env.KV.put(`session:${token}`, JSON.stringify({ user_id: user.id, role: user.role, shop_id: user.shop_id ?? null }), {
    expirationTtl: SESSION_TTL_S,
  });

  return c.json({
    success: true,
    data: {
      token,
      role: user.role,
      shop_id: user.shop_id ?? null,
    },
  });
});

// ─── POST /auth/register ──────────────────────────────────────────────────────
//
// Public (no token): may self-register ONLY as an unbound customer.
// Authenticated developer: may create any role and bind it to a shop_id.
// Admins/staff are onboarded via signed invite tokens (see routes/invites.ts),
// never via self-registration.

auth.post(
  "/register",
  rateLimit({ name: "register", limit: 10, windowS: 3600, key: clientIp }),
  async (c) => {
  // Optionally decode the caller's token — never fail if absent/invalid.
  let caller: JWTUser | null = null;
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const callerToken = authHeader.slice(7);
    try {
      const payload = (await verify(callerToken, c.env.JWT_SECRET, "HS256")) as unknown as JWTUser;
      // Same revocation rule as authMiddleware (WS-7): a signed JWT with no
      // live session:<token> KV record is revoked or was never issued — treat
      // it as unauthenticated so a revoked developer token cannot provision
      // privileged accounts.
      if ((await c.env.KV.get(`session:${callerToken}`)) !== null) {
        caller = payload;
      }
    } catch {
      // Token present but invalid — treat as unauthenticated (don't 401).
    }
  }

  const body = await c.req.json<{
    name?: string;
    email?: string;
    password?: string;
    role?: string;
    shop_id?: string;
  }>();

  if (!body.email || !body.password) {
    return c.json({ success: false, error: "email and password are required" }, 400);
  }
  if (!body.name?.trim()) {
    return c.json({ success: false, error: "name is required" }, 400);
  }

  // Privilege boundary (SEC-1): only an authenticated developer may choose a
  // role or bind the account to a shop. A public (non-developer) caller may
  // ONLY create an unbound customer; attempting to self-assign a privileged
  // role or attach to a shop_id is rejected. This closes the unauthenticated
  // shop-takeover vector (register role=admin + victim shop_id).
  const isDeveloper = caller?.role === "developer";

  if (!isDeveloper && ((body.role && body.role !== "customer") || body.shop_id)) {
    return c.json(
      { success: false, error: "Public registration can only create a customer account" },
      403
    );
  }

  const requestedRole = isDeveloper ? body.role ?? "customer" : "customer";
  const shopId = isDeveloper ? body.shop_id ?? null : null;

  const allValidRoles = ["customer", "admin", "staff", "developer"];
  if (!allValidRoles.includes(requestedRole)) {
    return c.json({ success: false, error: "Invalid role" }, 400);
  }

  const existing = await getUserByEmail(c.env.DB, body.email);
  if (existing) return c.json({ success: false, error: "Email already registered" }, 409);

  const id = crypto.randomUUID();
  const password_hash = await hashPassword(body.password);

  // SEC-3: a self-registered account has proven nothing about address
  // ownership, so it starts unverified and the email-matched customer surface
  // (/api/me bookings) stays closed until the verify link is clicked.
  // Developer-provisioned accounts are operator-vouched.
  await createUser(c.env.DB, {
    id,
    name: body.name.trim(),
    email: body.email,
    password_hash,
    role: requestedRole,
    shop_id: shopId,
    email_verified: isDeveloper ? 1 : 0,
  });

  let verificationEmailSent = false;
  if (!isDeveloper) {
    verificationEmailSent = await issueEmailVerification(c.env, id, body.email, body.name.trim());
  }

  return c.json(
    {
      success: true,
      data: {
        id,
        name: body.name.trim(),
        email: body.email,
        role: requestedRole,
        verification_email_sent: verificationEmailSent,
      },
    },
    201
  );
});

// ─── POST /auth/verify-email ─────────────────────────────────────────────────
//
// Public — the link lands in the user's inbox and they may not be logged in.
// The token is single-use and expires with its KV record. Rate-limited so the
// 122-bit token space cannot be scanned.

auth.post(
  "/verify-email",
  rateLimit({ name: "verify-email", limit: 20, windowS: 3600, key: clientIp }),
  async (c) => {
    const body = await c.req.json<{ token?: string }>().catch((): { token?: string } => ({}));
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token || token.length > 100) {
      return c.json({ success: false, error: "token is required" }, 400);
    }

    const raw = await c.env.KV.get(`everify:${token}`);
    if (!raw) {
      return c.json({ success: false, error: "This verification link is invalid or has expired." }, 400);
    }
    let userId: string | null = null;
    try {
      userId = (JSON.parse(raw) as { user_id?: string }).user_id ?? null;
    } catch {
      /* corrupt record — treat as invalid */
    }
    if (!userId) {
      return c.json({ success: false, error: "This verification link is invalid or has expired." }, 400);
    }

    await c.env.DB
      .prepare("UPDATE platform_users SET email_verified = 1 WHERE id = ?")
      .bind(userId)
      .run();
    await c.env.KV.delete(`everify:${token}`);

    return c.json({ success: true });
  }
);

// ─── POST /auth/resend-verification ──────────────────────────────────────────

auth.post(
  "/resend-verification",
  authMiddleware,
  rateLimit({ name: "resend-verify", limit: 3, windowS: 3600, key: (c) => getUser(c).sub }),
  async (c) => {
    const caller = getUser(c);
    const user = await getUserById(c.env.DB, caller.sub);
    if (!user) return c.json({ success: false, error: "User not found" }, 404);
    if (user.email_verified === 1) {
      return c.json({ success: false, error: "Email is already verified" }, 400);
    }

    const sent = await issueEmailVerification(c.env, user.id, user.email, user.name);
    if (!sent) {
      return c.json(
        { success: false, error: "Could not send the verification email. Please try again later." },
        502
      );
    }
    return c.json({ success: true });
  }
);

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

auth.get("/me", authMiddleware, async (c) => {
  const caller = getUser(c);
  const user = await getUserById(c.env.DB, caller.sub);
  if (!user) return c.json({ success: false, error: "User not found" }, 404);
  return c.json({ success: true, data: user });
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

auth.post("/logout", authMiddleware, async (c) => {
  // Same extraction as authMiddleware so cookie-based sessions revoke too.
  const token = extractSessionJwt(c.req.raw.headers);
  if (token) await c.env.KV.delete(`session:${token}`);
  return c.json({ success: true });
});

export default auth;
