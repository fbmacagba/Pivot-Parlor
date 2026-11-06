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

  it("refuses the fictional demo shops by backing id and by demo slug", async () => {
    // pp-demo-* rows are real platform shops that hold the generated demo
    // sites, so the guard must hold even when their slug is not the alias.
    await env.DB.prepare(
      `INSERT INTO shops (id, shop_number, slug, name, owner_email)
       VALUES ('pp-demo-ferdyms-barber', 990001, 'renamed-by-an-admin', 'Demo barber', 'demo-a@example.com'),
              ('pp-demo-linden-lark', 990002, 'linden-and-lark-demo', 'Demo salon', 'demo-b@example.com')`,
    ).run();
    const identities = [
      { shop_id: "pp-demo-ferdyms-barber" },
      { shop_slug: "renamed-by-an-admin" },
      { shop_slug: "linden-and-lark-demo" },
    ];
    for (const identity of identities) {
      const response = await dispatch("POST", "/api/waitlist", {
        body: { ...identity, customer_name: "Demo Guest", customer_email: "guest@example.com" },
      });
      expect(response.status).toBe(403);
    }
    for (const identity of ["pp-demo-ferdyms-barber", "renamed-by-an-admin", "linden-and-lark-demo"]) {
      const response = await dispatch("POST", `/api/walkin/${identity}/join`, { body: { name: "Demo Guest" } });
      expect(response.status).toBe(403);
    }
    const rows = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM waitlist WHERE shop_id LIKE 'pp-demo-%') + (SELECT COUNT(*) FROM walkin_queue WHERE shop_id LIKE 'pp-demo-%') AS n",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("leaves ordinary tenants' public queues open", async () => {
    const shopId = await seedShop("Ordinary shop");
    const response = await dispatch("POST", `/api/walkin/${shopId}/join`, { body: { name: "Real Guest" } });
    expect(response.status).not.toBe(403);
    expect(await response.json()).not.toMatchObject({ error: expect.stringContaining("demonstration") });
  });
});
