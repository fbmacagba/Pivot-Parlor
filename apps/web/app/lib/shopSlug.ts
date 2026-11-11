/**
 * The shop slug from a $shopSlug route's params, or a 404.
 *
 * Every slug the platform mints is toSlug(name) + "-NNN" (lowercase letters,
 * digits and dashes; shops.slug has no NOCASE collation), and the ids the API
 * also accepts are UUIDs or fixed "pp-demo-..." ids. Anything else is refused
 * before it reaches an API URL or a link on the page (see lib/pathSafety.ts
 * for the 2026-11-11 traversal this stops).
 */
const SHOP_SLUG = /^[a-z0-9-]+$/;

export function requireShopSlug(params: { shopSlug?: string }): string {
  const slug = params.shopSlug;
  if (typeof slug !== "string" || !SHOP_SLUG.test(slug)) {
    throw new Response("Shop not found", { status: 404 });
  }
  return slug;
}
