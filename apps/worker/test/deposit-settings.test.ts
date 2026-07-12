/**
 * Customer deposits (migration 041): shop_settings gains
 * deposits_enabled / deposit_percent / deposit_min_pence. The PATCH route
 * must accept + clamp them and the public GET must expose them (the booking
 * UI shows the deposit due before the customer commits).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor } from "./helpers";

async function slugOf(shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT slug FROM shops WHERE id = ?").bind(shopId).first<{ slug: string }>();
  return row!.slug;
}

describe("shop_settings deposit fields", () => {
  it("PATCH accepts the fields, clamps them, and GET exposes them", async () => {
    const shop = await seedShop("Deposit Settings Shop");
    const admin = await seedUser("admin", shop);
    const token = await tokenFor(admin, "admin", shop);

    const patch = await dispatch("PATCH", `/api/shops/${shop}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { deposits_enabled: true, deposit_percent: 250, deposit_min_pence: 750.4 },
    });
    expect(patch.status).toBe(200);

    const res = await dispatch("GET", `/api/shops/${await slugOf(shop)}/settings`);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.deposits_enabled).toBe(true);
    expect(data.deposit_percent).toBe(100); // clamped to 1..100
    expect(data.deposit_min_pence).toBe(750); // rounded integer pence

    // Toggle off round-trips too.
    await dispatch("PATCH", `/api/shops/${shop}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { deposits_enabled: false },
    });
    const res2 = await dispatch("GET", `/api/shops/${await slugOf(shop)}/settings`);
    const body2 = (await res2.json()) as { data: Record<string, unknown> };
    expect(body2.data.deposits_enabled).toBe(false);
  });

  it("defaults are exposed when the settings row exists without deposit config", async () => {
    const shop = await seedShop("Default Deposit Shop");
    const admin = await seedUser("admin", shop);
    const token = await tokenFor(admin, "admin", shop);
    // Create the row via an unrelated field.
    await dispatch("PATCH", `/api/shops/${shop}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { phone: "0123" },
    });
    const res = await dispatch("GET", `/api/shops/${await slugOf(shop)}/settings`);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.deposits_enabled).toBe(false);
    expect(data.deposit_percent).toBe(50);
    expect(data.deposit_min_pence).toBe(500);
  });
});
