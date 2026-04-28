import { Link, Outlet, useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";
import { createApiClient } from "~/lib/api";

export type DevShopDetail = {
  id: string;
  shop_number: number;
  name: string;
  slug: string;
  type: string;
  created_at?: string;
};

export type DevGenerationPrefs = {
  template: string;
  design_notes: string | null;
  color_primary: string | null;
  color_accent: string | null;
};

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const shopId = params.shopId!;
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) throw new Response("Unauthorized", { status: 401 });
  const api = createApiClient(env.API_URL, token, apiE2eHeadersFromCookieHeader(request.headers.get("Cookie")));

  let shop: DevShopDetail;
  try {
    shop = await api.get<DevShopDetail>(`/api/shops/${shopId}`);
  } catch {
    throw new Response("Shop not found", { status: 404 });
  }

  let generationPrefs: DevGenerationPrefs = {
    template: "minimal",
    design_notes: null,
    color_primary: null,
    color_accent: null,
  };
  try {
    generationPrefs = await api.get<DevGenerationPrefs>(`/api/shops/${shop.id}/generation-prefs`);
  } catch {
    /* defaults */
  }

  return json({ shop, generationPrefs });
}

export default function DevShopLayout() {
  const { shop, generationPrefs } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <div>
        <Link to="/dev/shops" className="text-sm text-gold hover:underline">
          ← Shops
        </Link>
      </div>
      <div>
        <h1 className="font-heading text-2xl font-bold text-white">{shop.name}</h1>
        <p className="mt-1 text-sm text-white/50">
          /{shop.slug} · #{shop.shop_number}
        </p>
      </div>
      <Outlet context={{ shop, generationPrefs }} />
    </div>
  );
}
