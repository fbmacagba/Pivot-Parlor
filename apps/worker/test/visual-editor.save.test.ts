import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

async function seedActiveSite(shopId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO shop_sites (id, shop_id, template, status) VALUES (?, ?, 'minimal', 'active')"
  ).bind(`site-${crypto.randomUUID()}`, shopId).run();
}

describe("save-image", () => {
  it("writes services.image_url for service:<id>", async () => {
    const shopId = await seedShop("Save Shop");
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));
    const svcId = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, 'Fade', 30, 1000, 'Hair')"
    ).bind(svcId, shopId).run();

    const res = await dispatch("POST", `/api/shops/${shopId}/save-image`, {
      headers: dev,
      body: { type: `service:${svcId}`, imageUrl: "https://x/service.png" },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT image_url FROM services WHERE id = ?").bind(svcId).first<{ image_url: string | null }>();
    expect(row?.image_url).toBe("https://x/service.png");
  });

  it("sets hero url and marks it locked", async () => {
    const shopId = await seedShop("Save Shop 2");
    await seedActiveSite(shopId);
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));

    const res = await dispatch("POST", `/api/shops/${shopId}/save-image`, {
      headers: dev,
      body: { type: "hero", imageUrl: "https://x/hero.png" },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT hero_image_url, locked_images_json FROM shop_sites WHERE shop_id = ?").bind(shopId).first<{ hero_image_url: string | null; locked_images_json: string | null }>();
    expect(row?.hero_image_url).toBe("https://x/hero.png");
    expect(JSON.parse(row?.locked_images_json ?? "{}").hero).toBe(true);
  });

  it("lets an admin of the shop save (upload path is not developer-only)", async () => {
    const shopId = await seedShop("Save Shop 3");
    const svcId = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, 'Cut', 30, 1000, 'Hair')"
    ).bind(svcId, shopId).run();
    const admin = authHeaders(await tokenFor(await seedUser("admin", shopId), "admin", shopId));
    const res = await dispatch("POST", `/api/shops/${shopId}/save-image`, {
      headers: admin,
      body: { type: `service:${svcId}`, imageUrl: "https://x/admin.png" },
    });
    expect(res.status).toBe(200);
  });
});
