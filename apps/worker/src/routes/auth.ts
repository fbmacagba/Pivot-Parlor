import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import type { Bindings } from "../bindings.js";
import { getUserByEmail, getUserById, createUser } from "../db/queries.js";
import { authMiddleware, extractSessionJwt, getUser, type JWTUser } from "../middleware/auth.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";
import { e2eMockAllowed } from "../lib/e2e.js";

const auth = new Hono<{ Bindings: Bindings }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const saltB64 = btoa(String.fromCharCode(...salt));
  return `${saltB64}:${hash}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltB64, hash] = storedHash.split(":");
  if (!saltB64 || !hash) return false;
  const enc = new TextEncoder();
  const salt = Uint8Array.from(atob(saltB64), (ch) => ch.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const derived = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return derived === hash;
}

const SESSION_TTL_S = 60 * 60 * 24 * 7; // 7 days

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
    try {
      caller = (await verify(authHeader.slice(7), c.env.JWT_SECRET, "HS256")) as unknown as JWTUser;
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

  await createUser(c.env.DB, {
    id,
    name: body.name.trim(),
    email: body.email,
    password_hash,
    role: requestedRole,
    shop_id: shopId,
  });

  return c.json({ success: true, data: { id, name: body.name.trim(), email: body.email, role: requestedRole } }, 201);
});

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
