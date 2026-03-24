import { Hono } from "hono";
import { sign } from "hono/jwt";
import type { Bindings } from "../bindings.js";

const oauth = new Hono<{ Bindings: Bindings }>();

const SESSION_TTL_S = 60 * 60 * 24 * 7; // 7 days

// ─── Helpers ──────────────────────────────────────────────────────────────────

function oauthState(redirectTo = "/"): string {
  return btoa(JSON.stringify({ redirectTo, ts: Date.now() }));
}

function parseState(state: string): { redirectTo: string } {
  try {
    return JSON.parse(atob(state));
  } catch {
    return { redirectTo: "/" };
  }
}

async function issueToken(
  env: Bindings,
  userId: string,
  role: string,
  shopId: string | null
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const payload = {
    sub: userId,
    role,
    ...(shopId ? { shop_id: shopId } : {}),
    exp,
  };
  const token = await sign(payload, env.JWT_SECRET);
  await env.KV.put(
    `session:${token}`,
    JSON.stringify({ user_id: userId, role, shop_id: shopId }),
    { expirationTtl: SESSION_TTL_S }
  );
  return token;
}

/** Find or create a platform_user from an OAuth identity, return the user row. */
async function upsertOAuthUser(
  env: Bindings,
  provider: string,
  providerId: string,
  email: string,
  name: string,
  avatarUrl: string | null
): Promise<{ id: string; role: string; shop_id: string | null }> {
  // 1. Does an OAuth account already exist for this provider+id?
  const existing = await env.DB.prepare(
    "SELECT u.id, u.role, u.shop_id FROM oauth_accounts oa JOIN platform_users u ON u.id = oa.user_id WHERE oa.provider = ? AND oa.provider_id = ?"
  )
    .bind(provider, providerId)
    .first<{ id: string; role: string; shop_id: string | null }>();

  if (existing) return existing;

  // 2. Does a platform_user exist with the same email?
  const byEmail = await env.DB.prepare(
    "SELECT id, role, shop_id FROM platform_users WHERE email = ?"
  )
    .bind(email)
    .first<{ id: string; role: string; shop_id: string | null }>();

  const userId = byEmail?.id ?? crypto.randomUUID();

  if (!byEmail) {
    // Create a new customer account — no password needed for OAuth users.
    await env.DB.prepare(
      "INSERT INTO platform_users (id, name, email, password_hash, role, shop_id) VALUES (?, ?, ?, '', 'customer', NULL)"
    )
      .bind(userId, name, email)
      .run();
  }

  // 3. Link the OAuth account.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO oauth_accounts (user_id, provider, provider_id, email, name, avatar_url) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(userId, provider, providerId, email, name, avatarUrl)
    .run();

  const role = byEmail?.role ?? "customer";
  const shopId = byEmail?.shop_id ?? null;
  return { id: userId, role, shop_id: shopId };
}

function cookieHeader(token: string, isProd: boolean): string {
  const maxAge = SESSION_TTL_S;
  return `pp_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Max-Age=${maxAge}; SameSite=Lax${isProd ? "; Secure" : ""}`;
}

function dashboardForRole(role: string): string {
  switch (role) {
    case "developer": return "/dev/dashboard";
    case "admin": return "/admin";
    case "staff": return "/staff";
    default: return "/account";
  }
}

function isProduction(env: Bindings): boolean {
  return (env.ENVIRONMENT ?? "") === "production";
}

// ─── GOOGLE ───────────────────────────────────────────────────────────────────

oauth.get("/google", (c) => {
  const redirectTo = c.req.query("redirect") ?? "/";
  const state = oauthState(redirectTo);
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    redirect_uri: `${c.env.APP_URL ?? "https://pivotparlor.com"}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

oauth.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state") ?? "";
  if (!code) return c.json({ success: false, error: "Missing code" }, 400);

  const { redirectTo } = parseState(state);

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: c.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      redirect_uri: `${c.env.APP_URL ?? "https://pivotparlor.com"}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) {
    return c.json({ success: false, error: "Google token exchange failed" }, 400);
  }

  // Fetch user profile
  const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const profile = await profileRes.json<{ sub?: string; email?: string; name?: string; picture?: string }>();

  if (!profile.sub || !profile.email) {
    return c.json({ success: false, error: "Could not fetch Google profile" }, 400);
  }

  const user = await upsertOAuthUser(
    c.env, "google", profile.sub, profile.email, profile.name ?? profile.email, profile.picture ?? null
  );

  const token = await issueToken(c.env, user.id, user.role, user.shop_id);
  const dest = redirectTo && redirectTo !== "/" ? redirectTo : dashboardForRole(user.role);

  return c.redirect(dest, 302, {
    "Set-Cookie": cookieHeader(token, isProduction(c.env)),
  } as Record<string, string>);
});

// ─── FACEBOOK ─────────────────────────────────────────────────────────────────

oauth.get("/facebook", (c) => {
  const redirectTo = c.req.query("redirect") ?? "/";
  const state = oauthState(redirectTo);
  const params = new URLSearchParams({
    client_id: c.env.FACEBOOK_OAUTH_APP_ID ?? "",
    redirect_uri: `${c.env.APP_URL ?? "https://pivotparlor.com"}/auth/facebook/callback`,
    response_type: "code",
    scope: "email,public_profile",
    state,
  });
  return c.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params}`);
});

oauth.get("/facebook/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state") ?? "";
  if (!code) return c.json({ success: false, error: "Missing code" }, 400);

  const { redirectTo } = parseState(state);

  const tokenRes = await fetch(
    `https://graph.facebook.com/v19.0/oauth/access_token?${new URLSearchParams({
      client_id: c.env.FACEBOOK_OAUTH_APP_ID ?? "",
      client_secret: c.env.FACEBOOK_OAUTH_APP_SECRET ?? "",
      redirect_uri: `${c.env.APP_URL ?? "https://pivotparlor.com"}/auth/facebook/callback`,
      code,
    })}`
  );
  const tokenData = await tokenRes.json<{ access_token?: string; error?: unknown }>();
  if (!tokenData.access_token) {
    return c.json({ success: false, error: "Facebook token exchange failed" }, 400);
  }

  const profileRes = await fetch(
    `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${tokenData.access_token}`
  );
  const profile = await profileRes.json<{ id?: string; name?: string; email?: string; picture?: { data?: { url?: string } } }>();

  if (!profile.id || !profile.email) {
    return c.json({ success: false, error: "Could not fetch Facebook profile — ensure email permission is granted" }, 400);
  }

  const user = await upsertOAuthUser(
    c.env, "facebook", profile.id, profile.email, profile.name ?? profile.email, profile.picture?.data?.url ?? null
  );

  const token = await issueToken(c.env, user.id, user.role, user.shop_id);
  const dest = redirectTo && redirectTo !== "/" ? redirectTo : dashboardForRole(user.role);

  return c.redirect(dest, 302, {
    "Set-Cookie": cookieHeader(token, isProduction(c.env)),
  } as Record<string, string>);
});

// ─── LINKEDIN ─────────────────────────────────────────────────────────────────

oauth.get("/linkedin", (c) => {
  const redirectTo = c.req.query("redirect") ?? "/";
  const state = oauthState(redirectTo);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: c.env.LINKEDIN_OAUTH_CLIENT_ID ?? "",
    redirect_uri: `${c.env.APP_URL ?? "https://pivotparlor.com"}/auth/linkedin/callback`,
    state,
    scope: "openid profile email",
  });
  return c.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
});

oauth.get("/linkedin/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state") ?? "";
  if (!code) return c.json({ success: false, error: "Missing code" }, 400);

  const { redirectTo } = parseState(state);

  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: c.env.LINKEDIN_OAUTH_CLIENT_ID ?? "",
      client_secret: c.env.LINKEDIN_OAUTH_CLIENT_SECRET ?? "",
      redirect_uri: `${c.env.APP_URL ?? "https://pivotparlor.com"}/auth/linkedin/callback`,
    }),
  });

  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) {
    return c.json({ success: false, error: "LinkedIn token exchange failed" }, 400);
  }

  // LinkedIn OpenID Connect userinfo endpoint
  const profileRes = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const profile = await profileRes.json<{ sub?: string; email?: string; name?: string; picture?: string }>();

  if (!profile.sub || !profile.email) {
    return c.json({ success: false, error: "Could not fetch LinkedIn profile" }, 400);
  }

  const user = await upsertOAuthUser(
    c.env, "linkedin", profile.sub, profile.email, profile.name ?? profile.email, profile.picture ?? null
  );

  const token = await issueToken(c.env, user.id, user.role, user.shop_id);
  const dest = redirectTo && redirectTo !== "/" ? redirectTo : dashboardForRole(user.role);

  return c.redirect(dest, 302, {
    "Set-Cookie": cookieHeader(token, isProduction(c.env)),
  } as Record<string, string>);
});

export default oauth;
