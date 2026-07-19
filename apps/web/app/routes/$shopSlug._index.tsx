import { Link, useRouteLoaderData, useSearchParams } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/cloudflare";
import { useState, useEffect } from "react";
import CommercialTemplate, { type SiteData } from "~/components/CommercialTemplate";
import { ReviewModal } from "~/components/ReviewModal";
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

  const [searchParams] = useSearchParams();
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewBookingId = searchParams.get("review");

  useEffect(() => {
    if (reviewBookingId) setReviewOpen(true);
  }, [reviewBookingId]);

  if (!shop) return null;

  if (!site) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dark px-6 text-center">
        <h1 className="font-heading text-3xl font-bold text-white sm:text-4xl">
          {shop.name}
        </h1>
        <p className="mt-4 text-white/60">
          We&apos;re getting our booking page ready. Check back soon.
        </p>
        <Link
          to="/"
          className="mt-8 text-sm text-gold hover:underline"
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
    layout_mood: s.layout_mood ?? undefined,
    brand_voice: s.brand_voice ?? undefined,
    hero_cta: s.hero_cta ?? undefined,
    about_title: s.about_title ?? undefined,
    trust_signals: Array.isArray(s.trust_signals) ? s.trust_signals : undefined,
    usps: Array.isArray(s.usps) ? s.usps : undefined,
    palette: s.palette && typeof s.palette === "object" ? s.palette : undefined,
    design_version: typeof s.design_version === "number" ? s.design_version : undefined,
    heading_weight:
      typeof s.heading_weight === "string" && s.heading_weight.trim() ? s.heading_weight.trim() : undefined,
    heading_style:
      typeof s.heading_style === "string" && s.heading_style.trim() ? s.heading_style.trim() : undefined,
    design_spec: s.design_spec ?? undefined,
  };

  return (
    <>
      <CommercialTemplate
        site={siteData}
        staff={staff}
        services={services}
        reviews={reviews}
        settings={settings}
      />
      {reviewOpen && (
        <ReviewModal
          shopId={shop.id}
          shopName={shop.name}
          shopSlug={shop.slug}
          bookingId={reviewBookingId}
          onClose={() => setReviewOpen(false)}
        />
      )}
    </>
  );
}
