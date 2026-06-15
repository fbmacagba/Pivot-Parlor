import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, bareTokenFor } from "./helpers";

/**
 * SEC-1 regression. POST /auth/register must not let an unauthenticated caller
 * self-assign a privileged role or bind the new account to a shop.
 *
 * Before the fix, a public request with role=admin + a victim's shop_id created
 * an admin account scoped to that shop (unauthenticated tenant takeover, since
 * requireShop authorizes on a shop_id match). Legitimate admins/staff are
 * onboarded via signed invite tokens, never via self-registration.
 */
describe("SEC-1: /auth/register privilege boundary", () => {
  it("rejects unauthenticated role=admin + shop_id (the takeover vector) and creates nothing", async () => {
    const victimShop = await seedShop("Victim Shop");
    const email = `attacker-${crypto.randomUUID()}@evil.test`;

    const res = await dispatch("POST", "/auth/register", {
      body: { name: "Mallory", email, password: "pw-123456", role: "admin", shop_id: victimShop },
    });

    expect(res.status).toBe(403);

    const row = await env.DB.prepare("SELECT role, shop_id FROM platform_users WHERE email = ?")
      .bind(email)
      .first<{ role: string; shop_id: string | null }>();
    expect(row).toBeNull();
  });

  it("rejects an unauthenticated customer that tries to bind to a shop_id", async () => {
    const victimShop = await seedShop("Victim Shop 2");
    const email = `cust-bind-${crypto.randomUUID()}@evil.test`;

    const res = await dispatch("POST", "/auth/register", {
      body: { name: "Mallory", email, password: "pw-123456", role: "customer", shop_id: victimShop },
    });

    expect(res.status).toBe(403);
    const row = await env.DB.prepare("SELECT id FROM platform_users WHERE email = ?").bind(email).first();
    expect(row).toBeNull();
  });

  it("allows a plain public customer registration (no role, no shop binding)", async () => {
    const email = `cust-${crypto.randomUUID()}@ok.test`;
    const res = await dispatch("POST", "/auth/register", {
      body: { name: "Casey", email, password: "pw-123456" },
    });

    expect(res.status).toBe(201);
    const row = await env.DB.prepare("SELECT role, shop_id FROM platform_users WHERE email = ?")
      .bind(email)
      .first<{ role: string; shop_id: string | null }>();
    expect(row?.role).toBe("customer");
    expect(row?.shop_id).toBeNull();
  });

  it("still lets an authenticated developer create an admin bound to a shop", async () => {
    const shop = await seedShop("Legit Shop");
    const devId = await seedUser("developer", null);
    const devToken = await bareTokenFor(devId, "developer", null);
    const email = `owner-${crypto.randomUUID()}@legit.test`;

    const res = await dispatch("POST", "/auth/register", {
      headers: { Authorization: `Bearer ${devToken}` },
      body: { name: "Owner", email, password: "pw-123456", role: "admin", shop_id: shop },
    });

    expect(res.status).toBe(201);
    const row = await env.DB.prepare("SELECT role, shop_id FROM platform_users WHERE email = ?")
      .bind(email)
      .first<{ role: string; shop_id: string | null }>();
    expect(row?.role).toBe("admin");
    expect(row?.shop_id).toBe(shop);
  });
});
