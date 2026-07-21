import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

describe("GET /visuals", () => {
  it("returns hero/logo/lock/catalog/services for a developer", async () => {
    const shopId = await seedShop("Vis Shop");
    await env.DB.prepare(
      "INSERT INTO shop_sites (id, shop_id, template, status, hero_image_url, logo_url, locked_images_json, catalog_images_json) VALUES (?, ?, 'minimal', 'active', 'https://x/hero.png', 'https://x/logo.png', '{\"hero\":true}', '[\"https://x/c0.png\"]')"
    ).bind(`site-${crypto.randomUUID()}`, shopId).run();
    const svcId = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, image_url) VALUES (?, ?, 'Fade', 30, 1000, 'Hair', 'https://x/svc.png')"
    ).bind(svcId, shopId).run();
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));

    const res = await dispatch("GET", `/api/shops/${shopId}/visuals`, { headers: dev });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        hero: { url: string | null; locked: boolean };
        logo: { url: string | null; locked: boolean };
        catalog: string[];
        services: Array<{ id: string; name: string; image_url: string | null }>;
      };
    };
    expect(body.data.hero).toEqual({ url: "https://x/hero.png", locked: true });
    expect(body.data.logo).toEqual({ url: "https://x/logo.png", locked: false });
    expect(body.data.catalog).toEqual(["https://x/c0.png"]);
    expect(body.data.services).toEqual([{ id: svcId, name: "Fade", image_url: "https://x/svc.png" }]);
  });

  it("403s for an admin of a different shop", async () => {
    const shopId = await seedShop("Vis Shop 2");
    const otherShop = await seedShop("Vis Other");
    const admin = authHeaders(await tokenFor(await seedUser("admin", otherShop), "admin", otherShop));
    const res = await dispatch("GET", `/api/shops/${shopId}/visuals`, { headers: admin });
    expect(res.status).toBe(403);
  });
});
