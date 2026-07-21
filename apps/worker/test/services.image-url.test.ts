import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop } from "./helpers";

describe("GET /api/shops/:shopId/services image_url", () => {
  it("returns each service's image_url (null when unset)", async () => {
    const shopId = await seedShop("Img Shop");
    const withImg = `svc-${crypto.randomUUID()}`;
    const without = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, image_url) VALUES (?, ?, 'A', 30, 1000, 'Hair', ?)"
    ).bind(withImg, shopId, "https://x/service-A.png").run();
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, 'B', 30, 1000, 'Hair')"
    ).bind(without, shopId).run();

    const res = await dispatch("GET", `/api/shops/${shopId}/services`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; image_url: string | null }> };
    const a = body.data.find((s) => s.id === withImg);
    const b = body.data.find((s) => s.id === without);
    expect(a?.image_url).toBe("https://x/service-A.png");
    expect(b?.image_url).toBeNull();
  });
});
