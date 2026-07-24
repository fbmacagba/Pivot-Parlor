/**
 * Unit tests for the shared Visual Editor image helpers. persistVisualImage is
 * the exact persist/lock/cache-bust path that both save-image and the
 * generate-image SUCCESS branch run, so exercising it here covers that logic
 * (including the KV bust and the logo-lock branch) without a real image call.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  parseVisualType,
  persistVisualImage,
  clearVisualImage,
  customVisualFilename,
} from "../src/services/visual-images";
import { seedShop } from "./helpers";

async function seedService(shopId: string, name = "Fade"): Promise<string> {
  const id = `svc-${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, ?, 30, 1000, 'Hair')"
  ).bind(id, shopId, name).run();
  return id;
}

async function seedActiveSite(shopId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO shop_sites (id, shop_id, template, status) VALUES (?, ?, 'minimal', 'active')"
  ).bind(`site-${crypto.randomUUID()}`, shopId).run();
}

describe("parseVisualType", () => {
  it("parses hero, logo and service:<id>", () => {
    expect(parseVisualType("hero")).toEqual({ kind: "hero" });
    expect(parseVisualType("logo")).toEqual({ kind: "logo" });
    expect(parseVisualType("service:abc-123")).toEqual({ kind: "service", serviceId: "abc-123" });
  });

  it("returns null for invalid, empty-id, missing or non-string input", () => {
    expect(parseVisualType("banner")).toBeNull();
    expect(parseVisualType("service:")).toBeNull(); // empty id: (.+) requires >=1 char
    expect(parseVisualType("")).toBeNull();
    expect(parseVisualType(undefined)).toBeNull();
    expect(parseVisualType(42)).toBeNull();
  });
});

describe("customVisualFilename", () => {
  it("namespaces every custom visual under custom- so pipeline keys (hero.png, logo.png, catalog-N.png) can never collide", () => {
    expect(customVisualFilename({ kind: "hero" })).toMatch(/^custom-hero-[0-9a-f]{8}\.png$/);
    expect(customVisualFilename({ kind: "logo" })).toMatch(/^custom-logo-[0-9a-f]{8}\.png$/);
    expect(customVisualFilename({ kind: "service", serviceId: "abc123" })).toMatch(
      /^custom-service-abc123-[0-9a-f]{8}\.png$/,
    );
  });

  it("returns a different name on every call so an existing R2 object is never overwritten", () => {
    expect(customVisualFilename({ kind: "hero" })).not.toBe(customVisualFilename({ kind: "hero" }));
  });
});

describe("persistVisualImage", () => {
  it("writes services.image_url for a service target and busts the site cache", async () => {
    const shopId = await seedShop("Persist Svc");
    const svcId = await seedService(shopId);
    await env.KV.put("site:persist-slug", "cached");

    await persistVisualImage(env.DB, env.KV, {
      shopId,
      slug: "persist-slug",
      target: { kind: "service", serviceId: svcId },
      imageUrl: "https://x/svc.png",
    });

    const row = await env.DB.prepare("SELECT image_url FROM services WHERE id = ?").bind(svcId).first<{ image_url: string | null }>();
    expect(row?.image_url).toBe("https://x/svc.png");
    expect(await env.KV.get("site:persist-slug")).toBeNull();
  });

  it("sets hero url + lock and busts the cache", async () => {
    const shopId = await seedShop("Persist Hero");
    await seedActiveSite(shopId);
    await env.KV.put("site:hero-slug", "cached");

    await persistVisualImage(env.DB, env.KV, {
      shopId,
      slug: "hero-slug",
      target: { kind: "hero" },
      imageUrl: "https://x/hero.png",
    });

    const row = await env.DB.prepare("SELECT hero_image_url, locked_images_json FROM shop_sites WHERE shop_id = ?").bind(shopId).first<{ hero_image_url: string | null; locked_images_json: string | null }>();
    expect(row?.hero_image_url).toBe("https://x/hero.png");
    expect(JSON.parse(row?.locked_images_json ?? "{}").hero).toBe(true);
    expect(await env.KV.get("site:hero-slug")).toBeNull();
  });

  it("sets logo url + lock, creating the draft shop_sites row when none exists", async () => {
    const shopId = await seedShop("Persist Logo");
    // No seedActiveSite: persistVisualImage must ensureDraftShopSiteRow first.
    await persistVisualImage(env.DB, env.KV, {
      shopId,
      slug: "logo-slug",
      target: { kind: "logo" },
      imageUrl: "https://x/logo.png",
    });

    const row = await env.DB.prepare("SELECT logo_url, locked_images_json FROM shop_sites WHERE shop_id = ? AND status = 'active'").bind(shopId).first<{ logo_url: string | null; locked_images_json: string | null }>();
    expect(row?.logo_url).toBe("https://x/logo.png");
    expect(JSON.parse(row?.locked_images_json ?? "{}").logo).toBe(true);
  });
});

describe("clearVisualImage", () => {
  it("clears a service image_url and busts the cache", async () => {
    const shopId = await seedShop("Clear Svc");
    const svcId = await seedService(shopId);
    await env.DB.prepare("UPDATE services SET image_url = 'https://x/a.png' WHERE id = ?").bind(svcId).run();
    await env.KV.put("site:clear-svc", "cached");

    await clearVisualImage(env.DB, env.KV, {
      shopId,
      slug: "clear-svc",
      target: { kind: "service", serviceId: svcId },
    });

    const row = await env.DB.prepare("SELECT image_url FROM services WHERE id = ?").bind(svcId).first<{ image_url: string | null }>();
    expect(row?.image_url).toBeNull();
    expect(await env.KV.get("site:clear-svc")).toBeNull();
  });

  it("clears hero url and its lock", async () => {
    const shopId = await seedShop("Clear Hero");
    await env.DB.prepare(
      "INSERT INTO shop_sites (id, shop_id, template, status, hero_image_url, locked_images_json) VALUES (?, ?, 'minimal', 'active', 'https://x/hero.png', '{\"hero\":true}')"
    ).bind(`site-${crypto.randomUUID()}`, shopId).run();

    await clearVisualImage(env.DB, env.KV, {
      shopId,
      slug: "clear-hero",
      target: { kind: "hero" },
    });

    const row = await env.DB.prepare("SELECT hero_image_url, locked_images_json FROM shop_sites WHERE shop_id = ?").bind(shopId).first<{ hero_image_url: string | null; locked_images_json: string | null }>();
    expect(row?.hero_image_url).toBeNull();
    expect(JSON.parse(row?.locked_images_json ?? "{}").hero).toBeUndefined();
  });

  it("clears logo url and its lock, leaving a hero lock intact", async () => {
    const shopId = await seedShop("Clear Logo");
    await env.DB.prepare(
      "INSERT INTO shop_sites (id, shop_id, template, status, hero_image_url, logo_url, locked_images_json) VALUES (?, ?, 'minimal', 'active', 'https://x/hero.png', 'https://x/logo.png', '{\"hero\":true,\"logo\":true}')"
    ).bind(`site-${crypto.randomUUID()}`, shopId).run();

    await clearVisualImage(env.DB, env.KV, {
      shopId,
      slug: "clear-logo",
      target: { kind: "logo" },
    });

    const row = await env.DB.prepare("SELECT hero_image_url, logo_url, locked_images_json FROM shop_sites WHERE shop_id = ?").bind(shopId).first<{ hero_image_url: string | null; logo_url: string | null; locked_images_json: string | null }>();
    expect(row?.logo_url).toBeNull();
    const parsed = JSON.parse(row?.locked_images_json ?? "{}");
    expect(parsed.logo).toBeUndefined();
    expect(parsed.hero).toBe(true); // only the logo lock is cleared
    expect(row?.hero_image_url).toBe("https://x/hero.png");
  });
});
