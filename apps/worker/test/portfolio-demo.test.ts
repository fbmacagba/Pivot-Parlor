import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop } from "./helpers";

describe("portfolio demo public queues", () => {
  it("refuses ID and slug requests without creating waitlist or walk-in entries", async () => {
    const shopId = await seedShop("Portfolio example");
    const slug = "ferdyms-barber-shop-014";
    await env.DB.prepare("UPDATE shops SET slug = ? WHERE id = ?")
      .bind(slug, shopId)
      .run();
    for (const identity of [{ shop_id: shopId }, { shop_slug: slug }]) {
      const response = await dispatch("POST", "/api/waitlist", {
        body: {
          ...identity,
          customer_name: "Demo Guest",
          customer_email: "guest@example.com",
        },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("demonstration"),
      });
    }
    for (const identity of [shopId, slug]) {
      const response = await dispatch("POST", `/api/walkin/${identity}/join`, {
        body: { name: "Demo Guest" },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("demonstration"),
      });
    }
    for (const table of ["waitlist", "walkin_queue"]) {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE shop_id = ?`,
      )
        .bind(shopId)
        .first<{ n: number }>();
      expect(row?.n).toBe(0);
    }
  });
});
