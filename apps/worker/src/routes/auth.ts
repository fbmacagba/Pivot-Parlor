import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import type { Bindings } from "../bindings.js";
import { getUserByEmail, getUserById, createUser } from "../db/queries.js";
import { authMiddleware, getUser, type JWTUser } from "../middleware/auth.js";

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

auth.post("/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  if (!body.email || !body.password) {
    return c.json({ success: false, error: "email and password are required" }, 400);
  }

  let user = await getUserByEmail(c.env.DB, body.email);

  // Bootstrap: if the developer account does not exist yet, create it on first login.
  if (!user && body.email === "dev@pivotparlor.com") {
    console.log("[auth/login] bootstrapping developer account for dev@pivotparlor.com");
    const id = crypto.randomUUID();
    const password_hash = await hashPassword(body.password);
    await createUser(c.env.DB, {
      id,
      name: "Developer",
      email: body.email,
      password_hash,
      role: "developer",
      shop_id: null,
    });
    user = await getUserByEmail(c.env.DB, body.email);
  }

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
// Public: admin / customer can self-register (no token required).
// Authenticated developer: can create any role including staff / developer.

auth.post("/register", async (c) => {
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

  const requestedRole = body.role ?? "customer";

  // Public (unauthenticated) registration is limited to admin + customer.
  const publicRoles = ["admin", "customer"];
  const privilegedRoles = ["staff", "developer"];

  if (privilegedRoles.includes(requestedRole) && caller?.role !== "developer") {
    return c.json(
      { success: false, error: `Only a developer can create ${requestedRole} accounts` },
      403
    );
  }

  const allValidRoles = [...publicRoles, ...privilegedRoles];
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
    shop_id: body.shop_id ?? null,
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
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.slice(7);
  if (token) await c.env.KV.delete(`session:${token}`);
  return c.json({ success: true });
});

export default auth;
