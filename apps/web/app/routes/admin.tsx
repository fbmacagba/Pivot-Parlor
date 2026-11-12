import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useLoaderData } from "@remix-run/react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { pageShopId } from "~/lib/pageShop";
import { DashboardLayout } from "~/components/dashboards/DashboardLayout";
import { ErrorScreen } from "~/components/ErrorScreen";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const url = new URL(request.url);
  const siteLive = url.searchParams.get("site_live") === "1";
  const siteGenerated = url.searchParams.get("siteGenerated") === "1";
  const shopId = pageShopId(request, user);

  // A developer is managing someone else's shop: name it in the banner so
  // there is no doubt whose settings, staff and bookings are on screen.
  let developerShopName: string | null = null;
  if (user.role === "developer" && shopId) {
    try {
      const api = createApiClient(env.API_URL, getSessionToken(request));
      const shop = await api.get<{ name?: string }>(`/api/shops/${shopId}`);
      developerShopName = shop?.name?.trim() || null;
    } catch {
      /* the banner falls back to the id */
    }
  }

  return json({ user, shopId, developerShopName, siteLive, siteGenerated });
}

const BANNER_LINK = "text-gold underline decoration-gold/60 hover:decoration-gold";

export default function AdminLayout() {
  const { user, shopId, developerShopName, siteLive, siteGenerated } = useLoaderData<typeof loader>();
  const isDeveloper = user.role === "developer";
  const devBanner = isDeveloper ? (
    <div className="rounded-lg border border-amber-500/45 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      <span className="font-medium text-amber-200">Developer view:</span>{" "}
      {shopId ? (
        <>
          you are managing <strong className="text-white">{developerShopName ?? shopId}</strong> as its admin.{" "}
        </>
      ) : (
        <>
          no shop chosen. Open one from{" "}
          <Link to="/dev/shops" className={BANNER_LINK}>
            Shops
          </Link>{" "}
          to manage it here.{" "}
        </>
      )}
      <Link to="/dev/dashboard" className={BANNER_LINK}>
        Back to developer dashboard
      </Link>
    </div>
  ) : null;
  const siteBanner =
    siteLive || siteGenerated ? (
      <div className="rounded-lg border border-green-500/40 bg-green-500/10 px-6 py-3 text-sm text-green-300">
        {siteGenerated ? "Your site has been generated" : "Your site is live"}
      </div>
    ) : null;

  return (
    <DashboardLayout
      role="admin"
      showDeveloperViewSwitcher={isDeveloper}
      shopName={isDeveloper ? (developerShopName ?? undefined) : shopId ? "Your Shop" : undefined}
      userName={user.sub}
      topBanner={
        devBanner || siteBanner ? (
          <div className="space-y-3 py-3">
            {devBanner}
            {siteBanner}
          </div>
        ) : undefined
      }
    />
  );
}

// Catches errors thrown by this layout's loader or any admin child route,
// so a failed API call shows a friendly screen instead of a blank page.
export function ErrorBoundary() {
  return <ErrorScreen />;
}
