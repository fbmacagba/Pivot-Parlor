/**
 * Visual Editor image helpers shared by the shop image endpoints
 * (upload-image / save-image / generate-image / remove-image), so the `type`
 * parsing and the persist/lock/cache-bust sequence stay identical across them.
 */
import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import {
  updateServiceImageUrl,
  updateShopSiteHeroImageUrl,
  updateShopSiteLogoUrl,
  setShopSiteImageLock,
  clearShopSiteImageLock,
  ensureDraftShopSiteRow,
} from "../db/queries.js";

/** A parsed target for a visual edit. `service` carries the service id. */
export type VisualType =
  | { kind: "hero" }
  | { kind: "logo" }
  | { kind: "service"; serviceId: string };

/**
 * Parse an image endpoint's `type` field ("hero" | "logo" | "service:<id>")
 * into a discriminated target, or null when it is missing/invalid. Shared by
 * all four image endpoints so the accepted shapes never drift apart.
 */
export function parseVisualType(rawType: unknown): VisualType | null {
  const type = typeof rawType === "string" ? rawType : "";
  if (type === "hero") return { kind: "hero" };
  if (type === "logo") return { kind: "logo" };
  const serviceId = /^service:(.+)$/.exec(type)?.[1];
  return serviceId ? { kind: "service", serviceId } : null;
}

/**
 * Filename for a custom visual write (owner upload / dev single-visual
 * regenerate). Two guarantees, both load-bearing:
 * - the `custom-` namespace is never written by the site pipeline (it writes
 *   hero.png / logo.png / catalog-<n>.png), so a locked visual's R2 bytes
 *   cannot be clobbered by a full-site regenerate;
 * - the random suffix makes every write a fresh object, so replacing a visual
 *   never serves stale bytes from caches keyed on the old URL.
 */
export function customVisualFilename(target: VisualType): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  const base = target.kind === "service" ? `service-${target.serviceId}` : target.kind;
  return `custom-${base}-${suffix}.png`;
}

/**
 * Persist a resolved image URL for a visual and, for hero/logo, mark it locked
 * so a full-site regenerate preserves it; then bust the public-site cache.
 * Shared by save-image and generate-image. The caller must have validated a
 * service target's shop ownership first.
 */
export async function persistVisualImage(
  db: D1Database,
  kv: KVNamespace,
  args: { shopId: string; slug: string; target: VisualType; imageUrl: string },
): Promise<void> {
  const { shopId, slug, target, imageUrl } = args;
  if (target.kind === "service") {
    await updateServiceImageUrl(db, target.serviceId, shopId, imageUrl);
  } else {
    await ensureDraftShopSiteRow(db, shopId);
    if (target.kind === "hero") {
      await updateShopSiteHeroImageUrl(db, shopId, imageUrl);
      await setShopSiteImageLock(db, shopId, "hero");
    } else {
      await updateShopSiteLogoUrl(db, shopId, imageUrl);
      await setShopSiteImageLock(db, shopId, "logo");
    }
  }
  await kv.delete(`site:${slug}`);
}

/**
 * Clear a visual and, for hero/logo, unlock it so a later regenerate may
 * overwrite it again; then bust the public-site cache. Used by remove-image.
 * The caller must have validated a service target's shop ownership first.
 */
export async function clearVisualImage(
  db: D1Database,
  kv: KVNamespace,
  args: { shopId: string; slug: string; target: VisualType },
): Promise<void> {
  const { shopId, slug, target } = args;
  if (target.kind === "service") {
    await updateServiceImageUrl(db, target.serviceId, shopId, null);
  } else if (target.kind === "hero") {
    await updateShopSiteHeroImageUrl(db, shopId, null);
    await clearShopSiteImageLock(db, shopId, "hero");
  } else {
    await updateShopSiteLogoUrl(db, shopId, null);
    await clearShopSiteImageLock(db, shopId, "logo");
  }
  await kv.delete(`site:${slug}`);
}
