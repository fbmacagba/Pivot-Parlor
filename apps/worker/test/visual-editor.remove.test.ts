import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

describe("remove-image", () => {
  it("clears a service's image_url (developer)", async () => {
    const shopId = await seedShop("Rm Shop");
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));
    const svcId = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, image_url) VALUES (?, ?, 'Fade', 30, 1000, 'Hair', 'https://x/a.png')"
    ).bind(svcId, shopId).run();

    const res = await dispatch("POST", `/api/shops/${shopId}/remove-image`, {
      headers: dev,
      body: { type: `service:${svcId}` },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT image_url FROM services WHERE id = ?").bind(svcId).first<{ image_url: string | null }>();
    expect(row?.image_url).toBeNull();
  });

  it("clears hero url and its lock (developer)", async () => {
    const shopId = await seedShop("Rm Shop 2");
    await env.DB.prepare(
      "INSERT INTO shop_sites (id, shop_id, template, status, hero_image_url, locked_images_json) VALUES (?, ?, 'minimal', 'active', 'https://x/hero.png', '{\"hero\":true}')"
    ).bind(`site-${crypto.randomUUID()}`, shopId).run();
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));

    const res = await dispatch("POST", `/api/shops/${shopId}/remove-image`, {
      headers: dev,
      body: { type: "hero" },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT hero_image_url, locked_images_json FROM shop_sites WHERE shop_id = ?").bind(shopId).first<{ hero_image_url: string | null; locked_images_json: string | null }>();
    expect(row?.hero_image_url).toBeNull();
    expect(JSON.parse(row?.locked_images_json ?? "{}").hero).toBeUndefined();
  });

  it("403s for an admin of the shop (remove is developer-only)", async () => {
    const shopId = await seedShop("Rm Shop 3");
    const admin = authHeaders(await tokenFor(await seedUser("admin", shopId), "admin", shopId));
    const res = await dispatch("POST", `/api/shops/${shopId}/remove-image`, {
      headers: admin,
      body: { type: "hero" },
    });
    expect(res.status).toBe(403);
  });
});
