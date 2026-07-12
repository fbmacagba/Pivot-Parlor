import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop } from "./helpers";

/**
 * WS-6: GET /api/shops/:slug/site must serve the persisted design intent
 * (trust_signals, usps, layout_mood, brand_voice, hero_cta, about_title) on
 * both the fresh-build path and the KV-cached path (pre-WS-6 cache snapshots
 * lack the fields, so the handler overlays them from D1).
 */

async function seedSite(shopId: string, withIntent: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO shop_sites (
       id, shop_id, template, headline, tagline, about, services_json,
       color_primary, color_accent, font_heading, font_body, status,
       trust_signals_json, usps_json, layout_mood, brand_voice, hero_cta, about_title, palette_json,
       design_version
     ) VALUES (?, ?, 'minimal', 'H', 'T', 'A', '[]', '#111111', '#c9a84c', 'Playfair Display', 'DM Sans', 'active',
       ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      shopId,
      withIntent ? JSON.stringify(["Fully insured", "5 star rated", "Walk-ins welcome"]) : null,
      withIntent ? JSON.stringify(["Master barbers", "Open late", "City centre"]) : null,
      withIntent ? "warm-editorial" : null,
      withIntent ? "warm and personal" : null,
      withIntent ? "Reserve your chair" : null,
      withIntent ? "The neighbourhood favourite" : null,
      withIntent ? JSON.stringify({ primary: "#111111", accent: "#c9a84c", background: "#faf6ef" }) : null,
      withIntent ? 2 : 1
    )
    .run();
}

async function slugOf(shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT slug FROM shops WHERE id = ?").bind(shopId).first<{ slug: string }>();
  return row!.slug;
}

describe("GET /api/shops/:slug/site design intent (WS-6)", () => {
  it("projects the persisted intent fields", async () => {
    const shop = await seedShop("Intent Shop");
    await seedSite(shop, true);

    const res = await dispatch("GET", `/api/shops/${await slugOf(shop)}/site`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.trust_signals).toEqual(["Fully insured", "5 star rated", "Walk-ins welcome"]);
    expect(data.usps).toEqual(["Master barbers", "Open late", "City centre"]);
    expect(data.layout_mood).toBe("warm-editorial");
    expect(data.brand_voice).toBe("warm and personal");
    expect(data.hero_cta).toBe("Reserve your chair");
    expect(data.about_title).toBe("The neighbourhood favourite");
    // WS-6 item 3: the full palette + version gate ride along.
    expect(data.palette).toEqual({ primary: "#111111", accent: "#c9a84c", background: "#faf6ef" });
    expect(data.design_version).toBe(2);
  });

  it("returns empty arrays / nulls for a pre-WS-6 site row", async () => {
    const shop = await seedShop("Legacy Shop");
    await seedSite(shop, false);

    const res = await dispatch("GET", `/api/shops/${await slugOf(shop)}/site`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.trust_signals).toEqual([]);
    expect(data.usps).toEqual([]);
    expect(data.layout_mood).toBeNull();
    expect(data.hero_cta).toBeNull();
    expect(data.palette).toBeNull();
    expect(data.design_version).toBe(1);
  });

  it("overlays the intent onto a stale KV cache snapshot", async () => {
    const shop = await seedShop("Cached Shop");
    await seedSite(shop, true);
    const slug = await slugOf(shop);

    // Pre-WS-6 snapshot: no design-intent fields.
    await env.KV.put(
      `site:${slug}`,
      JSON.stringify({ template: "minimal", headline: "Old", services: [], website_status: "live" })
    );

    const res = await dispatch("GET", `/api/shops/${slug}/site`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.headline).toBe("Old");
    expect(data.trust_signals).toEqual(["Fully insured", "5 star rated", "Walk-ins welcome"]);
    expect(data.layout_mood).toBe("warm-editorial");
    expect(data.hero_cta).toBe("Reserve your chair");
    expect(data.palette).toEqual({ primary: "#111111", accent: "#c9a84c", background: "#faf6ef" });
    expect(data.design_version).toBe(2);
  });
});
