import { Link, Outlet, useLoaderData, data as json } from "react-router";
import type { LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
import { ErrorScreen } from "~/components/ErrorScreen";
import { getSessionToken, requireRole } from "~/lib/auth";
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
  await requireRole(request, "developer", env.API_URL);
  const token = getSessionToken(request);
  if (!token) throw new Response("Unauthorized", { status: 401 });
  const api = createApiClient(env.API_URL, token, apiE2eHeadersFromCookieHeader(request.headers.get("Cookie")));

  // The public GET /api/shops/:id returns a minimal shape (no has_site,
  // website_status or hero/logo urls), so the full row still comes from the
  // developer shops list, matched by id. The other four reads take the same
  // id or slug and do not depend on it, so all five go out together.
  const key = encodeURIComponent(shopId);
  const [shopsR, prefsR, ownerR, visualsR, modelsR] = await Promise.allSettled([
    api.get<Shop[]>("/api/shops"),
    api.get<DevGenerationPrefs>(`/api/shops/${key}/generation-prefs`),
    api.get<DevShopOwnerDetails>(`/api/shops/${key}/owner-details`),
    api.get<VisualsData>(`/api/shops/${key}/visuals`),
    api.get<AIModel[]>("/api/ai/models"),
  ]);

  // "The list could not be read" and "this shop is not in it" are different
  // answers: only the second is a 404.
  if (shopsR.status === "rejected" || !Array.isArray(shopsR.value)) {
    throw new Response("The shop could not be loaded", { status: 502 });
  }
  const shop = shopsR.value.find((s) => s.id === shopId || s.slug === shopId);
  if (!shop) throw new Response("Shop not found", { status: 404 });

  return json({
    shop,
    apiUrl: env.API_URL,
    // The public site's origin: shop sites and this dashboard share it.
    publicOrigin: new URL(request.url).origin,
    // null when the read failed. The design notes are saved back on every
    // regeneration, so the page must not offer a blank form over real notes.
    generationPrefs: prefsR.status === "fulfilled" ? prefsR.value : null,
    ownerDetails: ownerR.status === "fulfilled" ? ownerR.value : null,
    visuals: visualsR.status === "fulfilled" ? visualsR.value : null,
    // Live-priced model list for the generation pickers; null falls back to
    // the snapshot in the page (the API worker caches this for an hour).
    models: modelsR.status === "fulfilled" && Array.isArray(modelsR.value) ? modelsR.value : null,
  });
}

// Deleting this shop from its own page must not reload this loader: the shop
// is gone, the reload would answer 404, and the page would show an error
// instead of going back to the list.
export const shouldRevalidate: ShouldRevalidateFunction = ({ formAction, defaultShouldRevalidate }) =>
  formAction && /\/api\/shops\/[^/]+\/delete\/?$/.test(formAction) ? false : defaultShouldRevalidate;

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/dev/shops" homeLabel="Back to shops" />;
}

export default function DevShopLayout() {
  const { shop, apiUrl, publicOrigin, generationPrefs, ownerDetails, visuals, models } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <div>
        <Link to="/dev/shops" className="tap-target inline-flex items-center text-sm text-gold hover:underline">
          <span aria-hidden>←&nbsp;</span>Shops
        </Link>
      </div>
      <div>
        <h1 className="font-heading text-2xl font-bold text-white">{shop.name}</h1>
        <p className="mt-1 text-sm text-white/60">
          /{shop.slug} · #{shop.shop_number}
        </p>
      </div>
      <Outlet context={{ shop, apiUrl, publicOrigin, generationPrefs, ownerDetails, visuals, models }} />
    </div>
  );
}
