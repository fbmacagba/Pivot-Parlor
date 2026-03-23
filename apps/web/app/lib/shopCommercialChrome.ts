import type { SiteData } from "~/components/commercialSiteTypes";

/** Minimal `SiteData` for nav/footer chrome on legal and auxiliary shop pages. */
export function siteDataForChrome(
  shopName: string,
  site: null | {
    color_primary?: string | null;
    color_accent?: string | null;
    font_heading?: string | null;
    font_body?: string | null;
    logo_url?: string | null;
    headline?: string | null;
  }
): SiteData {
  const s = site;
  return {
    shop_name: shopName,
    tagline: "",
    headline: typeof s?.headline === "string" && s.headline.trim() ? s.headline.trim() : undefined,
    font_heading: typeof s?.font_heading === "string" && s.font_heading.trim() ? s.font_heading.trim() : undefined,
    font_body: typeof s?.font_body === "string" && s.font_body.trim() ? s.font_body.trim() : undefined,
    logo_url: typeof s?.logo_url === "string" && s.logo_url.trim() ? s.logo_url.trim() : undefined,
    color_primary: s?.color_primary ?? undefined,
    color_accent: s?.color_accent ?? undefined,
  };
}
