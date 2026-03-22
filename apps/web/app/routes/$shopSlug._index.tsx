import { Link, useRouteLoaderData } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/cloudflare";
import CommercialTemplate, {
  type Service,
  type SiteData,
} from "~/components/CommercialTemplate";
import type { loader as shopLoader } from "./$shopSlug";
import type { ShopSiteData } from "./$shopSlug";

export const meta: MetaFunction<typeof shopLoader> = ({ data }) => {
  const title =
    data?.site?.seo_title?.trim() ||
    data?.site?.headline?.trim() ||
    data?.shop?.name ||
    "Book your appointment";
  return [{ title }];
};

function normalizeCommercialServices(
  rawList: Array<Record<string, unknown>>,
  catalog: string[]
): Service[] {
  return rawList.map((raw, index) => {
    const id = typeof raw.id === "string" ? raw.id : `svc-${index}`;
    const name = String(raw.name ?? "Service");
    const duration_minutes =
      typeof raw.duration_minutes === "number"
        ? raw.duration_minutes
        : typeof raw.duration_min === "number"
          ? raw.duration_min
          : 30;
    const price_gbp =
      typeof raw.price_gbp === "number"
        ? raw.price_gbp
        : typeof raw.price === "number"
          ? raw.price
          : 0;
    const category =
      typeof raw.category === "string" && raw.category ? raw.category : undefined;
    const description =
      typeof raw.description === "string" ? raw.description : undefined;
    const image_url =
      typeof raw.image_url === "string"
        ? raw.image_url
        : catalog[index % catalog.length] || undefined;
    return {
      id,
      name,
      duration_minutes,
      price_gbp,
      category,
      description,
      image_url,
    };
  });
}

export default function ShopLanding() {
  const data = useRouteLoaderData<typeof shopLoader>("routes/$shopSlug");
  const { shop, site, staff, reviews, settings } = data ?? {
    shop: null,
    site: null,
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
  const catalog = s.catalog_images ?? [];
  const services = normalizeCommercialServices(
    (s.services ?? []) as Array<Record<string, unknown>>,
    catalog
  );

  const reviewAvg =
    reviews.length > 0
      ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length
      : undefined;

  const siteData: SiteData = {
    shop_name: shop.name,
    tagline: s.tagline ?? "",
    hero_image_url: s.hero_image_url ?? undefined,
    logo_url: s.logo_url ?? undefined,
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
      shopCreatedAt={shop.created_at}
    />
  );
}
