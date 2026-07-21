import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  updateServiceImageUrl,
  setShopSiteImageLock,
  clearShopSiteImageLock,
  getShopSiteImages,
} from "../src/db/queries";
import { seedShop } from "./helpers";

async function seedService(shopId: string, name: string): Promise<string> {
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

describe("updateServiceImageUrl", () => {
  it("sets and clears a service's image_url, shop-scoped", async () => {
    const shopId = await seedShop("Q Shop");
    const svcId = await seedService(shopId, "Fade");
    await updateServiceImageUrl(env.DB, svcId, shopId, "https://x/service-1.png");
    let row = await env.DB.prepare("SELECT image_url FROM services WHERE id = ?").bind(svcId).first<{ image_url: string | null }>();
    expect(row?.image_url).toBe("https://x/service-1.png");
    await updateServiceImageUrl(env.DB, svcId, shopId, null);
    row = await env.DB.prepare("SELECT image_url FROM services WHERE id = ?").bind(svcId).first<{ image_url: string | null }>();
    expect(row?.image_url).toBeNull();
  });

  it("does not write a service in a different shop", async () => {
    const shopA = await seedShop("A");
    const shopB = await seedShop("B");
    const svcId = await seedService(shopA, "Cut");
    await updateServiceImageUrl(env.DB, svcId, shopB, "https://x/wrong.png");
    const row = await env.DB.prepare("SELECT image_url FROM services WHERE id = ?").bind(svcId).first<{ image_url: string | null }>();
    expect(row?.image_url).toBeNull();
  });
});

describe("hero/logo lock helpers", () => {
  it("sets then clears a lock key, round-tripping through JSON", async () => {
    const shopId = await seedShop("Lock Shop");
    await seedActiveSite(shopId);
    await setShopSiteImageLock(env.DB, shopId, "hero");
    let img = await getShopSiteImages(env.DB, shopId);
    expect(JSON.parse(img!.locked_images_json ?? "{}").hero).toBe(true);
    await setShopSiteImageLock(env.DB, shopId, "logo");
    img = await getShopSiteImages(env.DB, shopId);
    expect(JSON.parse(img!.locked_images_json ?? "{}").logo).toBe(true);
    await clearShopSiteImageLock(env.DB, shopId, "hero");
    img = await getShopSiteImages(env.DB, shopId);
    const parsed = JSON.parse(img!.locked_images_json ?? "{}");
    expect(parsed.hero).toBeUndefined();
    expect(parsed.logo).toBe(true);
  });
});
