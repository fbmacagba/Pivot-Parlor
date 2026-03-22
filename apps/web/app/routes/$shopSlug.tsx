import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { createApiClient } from "~/lib/api";
import type { Review, ShopSettings, StaffMember } from "~/components/CommercialTemplate";

export interface ShopSiteData {
  template: string;
  headline: string;
  tagline: string;
  about: string;
  services: Array<Record<string, unknown>>;
  color_primary: string;
  color_accent: string;
  font_heading: string;
  font_body: string;
  hero_image_url: string | null;
  logo_url: string | null;
  catalog_images: string[];
  seo_title?: string | null;
  seo_description?: string | null;
}

export async function loader({ params, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const api = createApiClient(env.API_URL);
  const slug = params.shopSlug!;

  type ShopPublic = {
    id: string;
    name: string;
    slug: string;
    phone?: string;
    created_at?: string;
  };
  let shop: ShopPublic | null = null;
  try {
    shop = await api.get<ShopPublic>(`/api/shops/${slug}`);
  } catch {
    throw new Response("Shop not found", { status: 404 });
  }

  let site: ShopSiteData | null = null;
  try {
    site = await api.get<ShopSiteData>(`/api/shops/${slug}/site`);
  } catch {
    /* Coming Soon */
  }

  const [staffR, reviewsR, settingsR] = await Promise.allSettled([
    api.get<StaffMember[]>(`/api/shops/${slug}/booking-staff`),
    api.get<Review[]>(`/api/shops/${slug}/reviews`),
    api.get<ShopSettings>(`/api/shops/${slug}/settings`),
  ]);

  const staff = staffR.status === "fulfilled" ? staffR.value : [];
  const reviews = reviewsR.status === "fulfilled" ? reviewsR.value : [];
  let settings: ShopSettings = settingsR.status === "fulfilled" ? settingsR.value : {};
  if (shop.phone?.trim() && !settings.phone?.trim()) {
    settings = { ...settings, phone: shop.phone };
  }

  return json({
    slug,
    shop: {
      name: shop.name,
      slug: shop.slug,
      phone: shop.phone,
      created_at: shop.created_at,
    },
    site,
    staff,
    reviews,
    settings,
  });
}

export default function ShopLayout() {
  return <Outlet />;
}
