import { Hono } from "hono";
import { sign } from "hono/jwt";
import type { Bindings } from "../bindings.js";
import {
  getInviteByToken,
  markInviteUsed,
  activateShop,
  getShopById,
  getUserByEmail,
  createUser,
  ensureE2ePlaywrightInviteReady,
  E2E_PLAYWRIGHT_INVITE_TOKEN,
} from "../db/queries.js";
import { e2eMockAllowed } from "../lib/e2e.js";
import { hashPassword } from "../lib/password.js";

const invites = new Hono<{ Bindings: Bindings }>();

const SESSION_TTL_S = 60 * 60 * 24 * 7; // 7 days

// ─── GET /api/invites/:token — validate and return invite details (public) ────

invites.get("/:token", async (c) => {
  const { token } = c.req.param();
  const e2eMock = e2eMockAllowed(c.env, c.req.header("X-E2E-Test-Mock"));
  if (e2eMock && token === E2E_PLAYWRIGHT_INVITE_TOKEN) {
    await ensureE2ePlaywrightInviteReady(c.env.DB);
  }
  if (e2eMock && token.startsWith("inactive-")) {
    return c.json({ success: false, error: "This invite is not yet active. Payment may still be pending." }, 400);
  }
  const invite = await getInviteByToken(c.env.DB, token);

  if (!invite) return c.json({ success: false, error: "Invite not found" }, 404);
  if (invite.used_at) return c.json({ success: false, error: "Invite already used" }, 410);
  if (invite.active === 0) {
    return c.json({ success: false, error: "This invite is not yet active. Payment may still be pending." }, 400);
  }
  if (new Date(invite.expires_at) < new Date()) {
    return c.json({ success: false, error: "Invite has expired" }, 410);
  }

  const shop = await getShopById(c.env.DB, invite.shop_id);

  return c.json({
    success: true,
    data: {
      email: invite.email,
      role: invite.role,
      expires_at: invite.expires_at,
      shop: shop ? { id: shop.id, name: shop.name, slug: shop.slug } : null,
    },
  });
});

// ─── POST /api/invites/:token/accept — set password, create user, activate shop

invites.post("/:token/accept", async (c) => {
  const { token } = c.req.param();

  const invite = await getInviteByToken(c.env.DB, token);
  if (!invite) return c.json({ success: false, error: "Invite not found" }, 404);
  if (invite.used_at) return c.json({ success: false, error: "Invite already used" }, 410);
  if (invite.active === 0) {
    return c.json({ success: false, error: "This invite is not yet active. Payment may still be pending." }, 400);
  }
  if (new Date(invite.expires_at) < new Date()) {
    return c.json({ success: false, error: "Invite has expired" }, 410);
  }

  const body = await c.req.json<{ name?: string; password?: string }>();
  if (!body.name?.trim() || !body.password || body.password.length < 8) {
    return c.json(
      { success: false, error: "name and a password of at least 8 characters are required" },
      400
    );
  }

  // Prevent duplicate accounts for the same email
  const existing = await getUserByEmail(c.env.DB, invite.email);
  if (existing) {
    return c.json({ success: false, error: "An account for this email already exists" }, 409);
  }

  const userId = crypto.randomUUID();
  const password_hash = await hashPassword(body.password);

  await createUser(c.env.DB, {
    id: userId,
    name: body.name.trim(),
    email: invite.email,
    password_hash,
    role: invite.role,
    shop_id: invite.shop_id,
    // Accepting a token that was emailed to this address proves ownership (SEC-3).
    email_verified: 1,
  });

  await markInviteUsed(c.env.DB, token);
  await activateShop(c.env.DB, invite.shop_id);

  // Issue session JWT so the user is logged in immediately
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const payload = {
    sub: userId,
    role: invite.role,
    shop_id: invite.shop_id,
    exp,
  };

  const jwt = await sign(payload, c.env.JWT_SECRET);

  await c.env.KV.put(
    `session:${jwt}`,
    JSON.stringify({ user_id: userId, role: invite.role, shop_id: invite.shop_id }),
    { expirationTtl: SESSION_TTL_S }
  );

  return c.json({
    success: true,
    data: {
      token: jwt,
      role: invite.role,
      shop_id: invite.shop_id,
    },
  }, 201);
});

export default invites;
