import { Link, useRouteLoaderData } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/cloudflare";
import CommercialTemplate, { type SiteData } from "~/components/CommercialTemplate";
import type { loader as shopLoader } from "./$shopSlug";
import type { ShopSiteData } from "./$shopSlug";

export const meta: MetaFunction<typeof shopLoader> = ({ data }) => {
  const shopName = data?.shop?.name ?? "Book your appointment";
  const title =
    data?.site?.seo_title?.trim() ||
    data?.site?.headline?.trim() ||
    shopName;
  const description =
    data?.site?.seo_description?.trim() ||
    data?.site?.about?.trim() ||
    `Book appointments at ${shopName} — powered by Pivot Parlor.`;
  const image = data?.site?.hero_image_url || data?.site?.logo_url || "";

  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    ...(image ? [{ property: "og:image", content: image }] : []),
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    ...(image ? [{ name: "twitter:image", content: image }] : []),
  ];
};

export default function ShopLanding() {
  const data = useRouteLoaderData<typeof shopLoader>("routes/$shopSlug");
  const { shop, site, commercialServices, staff, reviews, settings } = data ?? {
    shop: null,
    site: null,
    commercialServices: [],
    staff: [],
    reviews: [],
    settings: {},
  };

  if (!shop) return null;

  if (!site) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-[#0D0D0D] px-6 text-center">
        <h1 className="font-heading text-3xl font-bold text-white sm:text-4xl">
          {shop.name}
        </h1>
        <p className="mt-4 text-white/60">
          We&apos;re getting our booking page ready. Check back soon.
        </p>
        <Link
          to="/"
          className="mt-8 text-sm text-[#C9A84C] hover:underline"
        >
          Return home
        </Link>
      </main>
    );
  }

  const s = site as ShopSiteData;
  const services = commercialServices ?? [];

  const reviewAvg =
    reviews.length > 0
      ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length
      : undefined;

  const heroRaw = s.hero_image_url;
  const logoRaw = s.logo_url;
  const headlineRaw = s.headline;
  const taglineRaw = s.tagline;
  const aboutRaw = s.about;
  const siteData: SiteData = {
    shop_id: shop.id,
    shop_name: shop.name,
    headline:
      typeof headlineRaw === "string" && headlineRaw.trim() ? headlineRaw.trim() : undefined,
    tagline: typeof taglineRaw === "string" && taglineRaw.trim() ? taglineRaw.trim() : "",
    about: typeof aboutRaw === "string" && aboutRaw.trim() ? aboutRaw.trim() : undefined,
    font_heading: typeof s.font_heading === "string" && s.font_heading.trim() ? s.font_heading.trim() : undefined,
    font_body: typeof s.font_body === "string" && s.font_body.trim() ? s.font_body.trim() : undefined,
    hero_image_url:
      typeof heroRaw === "string" && heroRaw.trim() ? heroRaw.trim() : undefined,
    logo_url: typeof logoRaw === "string" && logoRaw.trim() ? logoRaw.trim() : undefined,
    color_primary: s.color_primary ?? undefined,
    color_accent: s.color_accent ?? undefined,
    seo_title: s.seo_title ?? undefined,
    description: (s.seo_description ?? s.about) || undefined,
    rating: reviewAvg,
    review_count: reviews.length,
  };

  return (
    <CommercialTemplate
      site={siteData}
      staff={staff}
      services={services}
      reviews={reviews}
      settings={settings}
    />
  );
}
