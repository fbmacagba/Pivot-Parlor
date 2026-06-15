/**
 * Reproduces the exact contract the admin dashboard depends on:
 * a valid admin login must yield a token whose /auth/me reports role="admin"
 * and the bound shop_id. The Remix /admin loader gates on requireRole("admin"),
 * which calls GET /auth/me — so if this contract breaks, the dashboard is
 * inaccessible after a valid login.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop } from "./helpers";

/** Hash a password exactly the way routes/auth.ts hashPassword() does. */
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

async function seedAdmin(shopId: string, email: string, password: string): Promise<string> {
  const id = `user-admin-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO platform_users (id, name, email, password_hash, role, shop_id)
     VALUES (?, ?, ?, ?, 'admin', ?)`
  )
    .bind(id, "Test Admin", email, await hashPassword(password), shopId)
    .run();
  return id;
}

describe("admin dashboard access upon valid login", () => {
  it("login as an admin returns role=admin + shop_id, and /auth/me confirms it", async () => {
    const shopId = await seedShop("Admin Login Shop");
    const email = `admin-${crypto.randomUUID()}@test.local`;
    const password = "correct-horse-battery-staple";
    const adminId = await seedAdmin(shopId, email, password);

    // 1. POST /auth/login — what login.tsx action calls.
    const loginRes = await dispatch("POST", "/auth/login", {
      body: { email, password },
    });
    expect(loginRes.status).toBe(200);
    const loginBody = (await loginRes.json()) as {
      success: boolean;
      data: { token: string; role: string; shop_id: string | null };
    };
    expect(loginBody.success).toBe(true);
    expect(loginBody.data.role).toBe("admin");
    expect(loginBody.data.shop_id).toBe(shopId);
    expect(typeof loginBody.data.token).toBe("string");
    expect(loginBody.data.token.length).toBeGreaterThan(0);

    // 2. GET /auth/me with that token — what the /admin loader's requireRole does.
    const meRes = await dispatch("GET", "/auth/me", {
      headers: { Authorization: `Bearer ${loginBody.data.token}` },
    });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      success: boolean;
      data: { id: string; role: string; shop_id: string | null };
    };
    expect(meBody.success).toBe(true);
    expect(meBody.data.id).toBe(adminId);
    expect(meBody.data.role).toBe("admin");
    expect(meBody.data.shop_id).toBe(shopId);
  });

  it("an admin token reaches admin-scoped dashboard endpoints for its own shop", async () => {
    const shopId = await seedShop("Admin Scope Shop");
    const email = `admin-${crypto.randomUUID()}@test.local`;
    const password = "another-good-password";
    await seedAdmin(shopId, email, password);

    const loginRes = await dispatch("POST", "/auth/login", { body: { email, password } });
    const loginBody = (await loginRes.json()) as { data: { token: string } };
    const token = loginBody.data.token;

    // The admin overview loader reads these; a 401/403 here would surface as an
    // empty (or, for the layout, a thrown) dashboard. They must not be forbidden.
    const stats = await dispatch("GET", `/api/shops/${shopId}/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stats.status).not.toBe(401);
    expect(stats.status).not.toBe(403);
  });
});
