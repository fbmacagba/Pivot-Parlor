import { useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { pageShopId } from "~/lib/pageShop";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { VisualManager, type VisualsData } from "~/components/VisualManager";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user);

  let visuals: VisualsData | null = null;
  if (shopId) {
    try {
      visuals = await api.get<VisualsData>(`/api/shops/${shopId}/visuals`);
    } catch {
      visuals = null;
    }
  }

  return json({
    visuals,
    shopId,
    apiUrl: env.API_URL,
    developerNeedsShop: user.role === "developer" && !shopId,
  });
}

export default function AdminVisuals() {
  const { visuals, shopId, apiUrl, developerNeedsShop } = useLoaderData<typeof loader>();

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-bold text-white">Visuals</h1>
        <p className="mt-0.5 text-sm text-white/60">
          Upload your own logo, hero or service photos. Your images are kept when the site is regenerated.
        </p>
      </div>

      {developerNeedsShop ? (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to manage visuals as a developer.
        </div>
      ) : null}

      {shopId && visuals ? (
        <VisualManager role="admin" shopId={shopId} apiUrl={apiUrl} {...visuals} />
      ) : !developerNeedsShop ? (
        <p className="text-sm text-white/60">Visuals are unavailable for this shop right now.</p>
      ) : null}
    </div>
  );
}
