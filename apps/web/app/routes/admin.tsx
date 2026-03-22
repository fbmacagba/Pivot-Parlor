import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useLoaderData } from "@remix-run/react";
import { requireRole } from "~/lib/auth";
import { DashboardLayout } from "~/components/dashboards/DashboardLayout";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const url = new URL(request.url);
  const siteLive = url.searchParams.get("site_live") === "1";
  const siteGenerated = url.searchParams.get("siteGenerated") === "1";
  return json({ user, siteLive, siteGenerated });
}

export default function AdminLayout() {
  const { user, siteLive, siteGenerated } = useLoaderData<typeof loader>();
  return (
    <DashboardLayout
      role="admin"
      shopName={user.shop_id ? "Your Shop" : undefined}
      userName={user.sub}
      topBanner={
        siteLive || siteGenerated ? (
          <div className="rounded-lg border border-green-500/40 bg-green-500/10 px-6 py-3 text-sm text-green-300">
            {siteGenerated ? "Your site has been generated" : "Your site is live"}
          </div>
        ) : undefined
      }
    />
  );
}
