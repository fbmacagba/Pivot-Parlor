/**
 * The public site payload built from a shop_sites row. Shared by
 * GET /api/shops/:shopId/site and the owner-review preview
 * (GET /api/shops/:shopId/site-candidate), so a preview renders exactly the
 * shape the public site will read after Publish.
 */
import { safeJsonParse } from "@repo/utils";
import type { DBShopSite } from "../db/queries.js";

type SiteRow = DBShopSite & {
  website_status?: string | null;
  seo_title?: string | null;
  seo_description?: string | null;
  trust_signals_json?: string | null;
  usps_json?: string | null;
  layout_mood?: string | null;
  brand_voice?: string | null;
  hero_cta?: string | null;
  about_title?: string | null;
  palette_json?: string | null;
  design_version?: number | null;
  heading_weight?: string | null;
  heading_style?: string | null;
  design_spec?: string | null;
  gallery_images_json?: string | null;
};

/** Design intent persisted by the assembler (WS-6 onward), arrays parsed so
 *  the web loader receives plain data. */
export function siteDesignIntent(site: SiteRow) {
  return {
    // Generated "the space" photos (migration 048), separate from the
    // positional per-service catalog. Read fresh from D1 like the hero.
    gallery_images: (safeJsonParse<unknown[]>(site.gallery_images_json ?? undefined) ?? []).filter(
      (u): u is string => typeof u === "string" && u.trim().length > 0
    ),
    trust_signals: safeJsonParse<string[]>(site.trust_signals_json) ?? [],
    usps: safeJsonParse<string[]>(site.usps_json) ?? [],
    layout_mood: site.layout_mood ?? null,
    brand_voice: site.brand_voice ?? null,
    hero_cta: site.hero_cta ?? null,
    about_title: site.about_title ?? null,
    // WS-6 item 3: full research palette + the version gate that decides
    // whether the web renders palette tokens (>= 2) or the legacy dark theme.
    palette: safeJsonParse<Record<string, string>>(site.palette_json),
    design_version: site.design_version ?? 1,
    // WS-6 item 5: curated typography. The web honours heading_weight only on
    // v2 sites; heading_style hints serif/sans when resolving legacy fonts.
    heading_weight: site.heading_weight ?? null,
    heading_style: site.heading_style ?? null,
    // Site Design v3 (Design Director): the composition spec, if the site was
    // generated/composed at design_version >= 3. NULL for v1/v2 sites.
    design_spec: safeJsonParse<unknown>(site.design_spec ?? undefined) ?? null,
  };
}

export function siteWebsiteStatus(site: SiteRow): string {
  return site.website_status ?? "draft";
}

/** The full public payload for a row (what /site caches in KV). */
export function buildSiteData(site: SiteRow) {
  return {
    template: site.template,
    headline: site.headline,
    tagline: site.tagline,
    about: site.about,
    services: safeJsonParse<unknown[]>(site.services_json) ?? [],
    color_primary: site.color_primary,
    color_accent: site.color_accent,
    font_heading: site.font_heading,
    font_body: site.font_body,
    hero_image_url: site.hero_image_url,
    logo_url: site.logo_url,
    catalog_images: safeJsonParse<unknown[]>(site.catalog_images_json) ?? [],
    seo_title: site.seo_title ?? null,
    seo_description: site.seo_description ?? null,
    website_status: siteWebsiteStatus(site),
    ...siteDesignIntent(site),
  };
}
