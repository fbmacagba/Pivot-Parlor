import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedComposeDesignSpec } from "@repo/utils";
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
       heading_weight, heading_style, design_version
     ) VALUES (?, ?, 'minimal', 'H', 'T', 'A', '[]', '#111111', '#c9a84c', 'Playfair Display', 'DM Sans', 'active',
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      withIntent ? "800" : null,
      withIntent ? "serif" : null,
      withIntent ? 2 : 1
    )
    .run();
}

async function slugOf(shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT slug FROM shops WHERE id = ?").bind(shopId).first<{ slug: string }>();
  return row!.slug;
}

/** Task 5: seed a shop_sites row carrying (or lacking) a Design Director spec. */
async function seedSiteWithDesignSpec(
  shopId: string,
  designSpec: unknown | null,
  designVersion: number
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO shop_sites (
       id, shop_id, template, headline, tagline, about, services_json,
       color_primary, color_accent, font_heading, font_body, status,
       design_spec, design_version
     ) VALUES (?, ?, 'minimal', 'H', 'T', 'A', '[]', '#111111', '#c9a84c', 'Playfair Display', 'DM Sans', 'active', ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      shopId,
      designSpec === null ? null : JSON.stringify(designSpec),
      designVersion
    )
    .run();
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
    // WS-6 item 5: curated typography rides along too.
    expect(data.heading_weight).toBe("800");
    expect(data.heading_style).toBe("serif");
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
    expect(data.heading_weight).toBeNull();
    expect(data.heading_style).toBeNull();
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
    expect(data.heading_weight).toBe("800");
    expect(data.heading_style).toBe("serif");
  });
});

describe("GET /api/shops/:slug/site design_spec (Task 5)", () => {
  it("projects the persisted design_spec for a v3 site", async () => {
    const shop = await seedShop("Spec Shop");
    await seedSiteWithDesignSpec(shop, seedComposeDesignSpec("site-spec-shop"), 3);

    const res = await dispatch("GET", `/api/shops/${await slugOf(shop)}/site`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    const spec = data.design_spec as { hero?: { variant?: unknown } } | null;
    expect(typeof spec?.hero?.variant).toBe("string");
    expect(data.design_version).toBe(3);
  });

  it("returns null design_spec for a NULL column", async () => {
    const shop = await seedShop("No Spec Shop");
    await seedSiteWithDesignSpec(shop, null, 1);

    const res = await dispatch("GET", `/api/shops/${await slugOf(shop)}/site`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.design_spec).toBeNull();
  });

  it("overlays design_spec onto a stale KV cache snapshot written before this field existed", async () => {
    const shop = await seedShop("Cached Spec Shop");
    await seedSiteWithDesignSpec(shop, seedComposeDesignSpec("cached-spec-shop"), 3);
    const slug = await slugOf(shop);

    // Pre-Task-5 snapshot: no design_spec key at all.
    await env.KV.put(
      `site:${slug}`,
      JSON.stringify({ template: "minimal", headline: "Old", services: [], website_status: "live" })
    );

    const res = await dispatch("GET", `/api/shops/${slug}/site`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.headline).toBe("Old");
    const spec = data.design_spec as { hero?: { variant?: unknown } } | null;
    expect(typeof spec?.hero?.variant).toBe("string");
    expect(data.design_version).toBe(3);
  });
});
