import { useMatches } from "@remix-run/react";

export interface ShopMatch {
  slug: string;
  /** Shop display name; falls back to the slug if the loader data is absent. */
  name: string;
}

/**
 * Returns the shop currently being viewed when the route tree includes the
 * public $shopSlug layout, else null. Used to swap PWA identity (manifest
 * link, install copy, iOS title) between the platform app and the shop's own
 * app. Safe in root.tsx's Layout, including during error-boundary renders
 * where match data may be missing.
 */
export function useShopMatch(): ShopMatch | null {
  const matches = useMatches();
  // Every match carries the URL's full params (the root too), but only the
  // $shopSlug layout loads the shop, so read the name from whichever match
  // has it rather than from the first match with the param.
  let slug: string | null = null;
  for (const m of matches) {
    const matchSlug = (m.params as { shopSlug?: string }).shopSlug;
    if (!matchSlug) continue;
    slug ??= matchSlug;
    const name = (m.data as { shop?: { name?: unknown } } | undefined)?.shop?.name;
    if (typeof name === "string" && name.trim()) return { slug: matchSlug, name };
  }
  return slug ? { slug, name: slug } : null;
}
