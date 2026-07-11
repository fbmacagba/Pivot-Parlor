import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import { dispatch } from "./request";
import { seedShop, tokenFor } from "./helpers";

/**
 * WS-7: the booking worker's authMiddleware must enforce KV session
 * revocation exactly like the main worker — a validly SIGNED token whose
 * session:<token> record is gone (logout / admin revocation) is dead, because
 * this is the surface that captures deposits and writes the commission ledger.
 */

describe("booking worker session revocation", () => {
  it("rejects a signed token that has no session record (revoked/logged out)", async () => {
    const shop = await seedShop("Revoked Shop");
    const bareToken = await sign(
      { sub: "user-admin", role: "admin", shop_id: shop, exp: Math.floor(Date.now() / 1000) + 3600 },
      "test-secret"
    );

    const res = await dispatch("GET", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${bareToken}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ success: boolean; error: string }>();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/revoked|expired/i);
  });

  it("accepts the same token once its session record exists, then rejects after revocation", async () => {
    const shop = await seedShop("Live Shop");
    const token = await tokenFor("admin", shop);

    const ok = await dispatch("GET", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);

    // Logout deletes the KV record — the still-valid signature must now fail.
    await env.KV.delete(`session:${token}`);
    const revoked = await dispatch("GET", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revoked.status).toBe(401);
  });
});
