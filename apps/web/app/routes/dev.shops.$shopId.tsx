import { Link, Outlet, useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";
import { createApiClient } from "~/lib/api";
import type { Shop } from "~/components/dev-shops/types";
import type { VisualsData } from "~/components/VisualManager";
import type { AIModel } from "@repo/types";

export type DevGenerationPrefs = {
  template: string;
  design_notes: string | null;
  color_primary: string | null;
  color_accent: string | null;
};

export type DevShopOwnerDetails = {
  owner_name: string;
  owner_email: string;
  phone: string;
  platform_users: {
    id: string;
    name: string | null;
    email: string;
    phone: string | null;
    role: string;
    shop_id: string | null;
    created_at: string;
  }[];
};

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const shopId = params.shopId!;
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) throw new Response("Unauthorized", { status: 401 });
  const api = createApiClient(env.API_URL, token, apiE2eHeadersFromCookieHeader(request.headers.get("Cookie")));

  // The public GET /api/shops/:id returns a minimal shape; the regenerate hub
  // needs the developer-scoped fields (has_site, website_status, hero/logo
  // urls), so pull the full row from the developer shops list and match by id.
  let shop: Shop;
  try {
    const shops = await api.get<Shop[]>("/api/shops");
    const found = shops.find((s) => s.id === shopId || s.slug === shopId);
    if (!found) throw new Error("not found");
    shop = found;
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

  let ownerDetails: DevShopOwnerDetails | null = null;
  try {
    ownerDetails = await api.get<DevShopOwnerDetails>(`/api/shops/${shop.id}/owner-details`);
  } catch {
    ownerDetails = null;
  }

  let visuals: VisualsData | null = null;
  try {
    visuals = await api.get<VisualsData>(`/api/shops/${shop.id}/visuals`);
  } catch {
    visuals = null;
  }

  // Live-priced model list for the generation pickers; null falls back to the
  // snapshot in the route (the API worker caches this for an hour).
  let models: AIModel[] | null = null;
  try {
    models = await api.get<AIModel[]>("/api/ai/models");
  } catch {
    models = null;
  }

  return json({ shop, apiUrl: env.API_URL, generationPrefs, ownerDetails, visuals, models });
}

export default function DevShopLayout() {
  const { shop, apiUrl, generationPrefs, ownerDetails, visuals, models } = useLoaderData<typeof loader>();

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
      <Outlet context={{ shop, apiUrl, generationPrefs, ownerDetails, visuals, models }} />
    </div>
  );
}
