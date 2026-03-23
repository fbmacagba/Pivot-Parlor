import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useLoaderData } from "@remix-run/react";
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
  const isDeveloper = user.role === "developer";
  const devBanner = isDeveloper ? (
    <div className="rounded-lg border border-amber-500/45 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      <span className="font-medium text-amber-200">Developer View</span>
      {" — "}
      you are viewing this as <strong className="text-white">admin</strong> dashboard.{" "}
      <Link to="/dev/dashboard" className="text-gold underline decoration-gold/60 hover:decoration-gold">
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
      shopName={user.shop_id ? "Your Shop" : undefined}
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
