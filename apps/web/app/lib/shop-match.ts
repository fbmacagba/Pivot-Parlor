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
  for (const m of matches) {
    const slug = (m.params as { shopSlug?: string }).shopSlug;
    if (slug) {
      const data = m.data as { shop?: { name?: string } } | undefined;
      return { slug, name: data?.shop?.name ?? slug };
    }
  }
  return null;
}
