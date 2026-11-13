import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { ErrorScreen } from "~/components/ErrorScreen";
import { json } from "@remix-run/cloudflare";
import { Link, useLoaderData } from "@remix-run/react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { dashboardHref, pageShopId, pageStaffId } from "~/lib/pageShop";
import { DashboardLayout } from "~/components/dashboards/DashboardLayout";

interface DeveloperView {
  shopId: string | null;
  shopName: string | null;
  /** The shop's current staff, any of whom the developer can view. */
  staff: Array<{ id: string; display_name: string }>;
  /** Whose screens are on show, once a current staff member is chosen. */
  viewing: { id: string; name: string } | null;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "staff", env.API_URL);
  if (user.role !== "developer") return json({ user, developerView: null });

  // Staff View is one person's own day, and a developer is nobody's staff:
  // they pick a shop (?shopId=) and one of its staff (?staffId=), and the
  // pages show exactly that person's screens, read-only.
  const shopId = pageShopId(request, user);
  const staffId = pageStaffId(request, user);
  const developerView: DeveloperView = { shopId, shopName: null, staff: [], viewing: null };
  if (shopId) {
    const api = createApiClient(env.API_URL, getSessionToken(request));
    const [shop, staff] = await Promise.all([
      api.get<{ name?: string }>(`/api/shops/${shopId}`).catch(() => null),
      api
        .get<Array<{ id: string; display_name: string; is_active: boolean | number }>>(`/api/shops/${shopId}/staff`)
        .catch(() => []),
    ]);
    developerView.shopName = shop?.name?.trim() || null;
    developerView.staff = (Array.isArray(staff) ? staff : [])
      .filter((s) => Boolean(s.is_active))
      .map((s) => ({ id: s.id, display_name: s.display_name }));
    const chosen = developerView.staff.find((s) => s.id === staffId);
    developerView.viewing = chosen ? { id: chosen.id, name: chosen.display_name } : null;
  }
  return json({ user, developerView });
}

const BANNER_LINK = "text-gold underline decoration-gold/60 hover:decoration-gold";

function DeveloperBanner({ view }: { view: DeveloperView }) {
  const shopLabel = view.shopName ?? view.shopId;
  return (
    <div className="rounded-lg border border-amber-500/45 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      <span className="font-medium text-amber-200">Developer view:</span>{" "}
      {!view.shopId ? (
        <>
          no shop chosen. Open one from{" "}
          <Link to="/dev/shops" className={BANNER_LINK}>
            Shops
          </Link>{" "}
          to see its staff screens here.{" "}
        </>
      ) : view.viewing ? (
        <>
          you are viewing <strong className="text-white">{view.viewing.name}</strong>&apos;s screens at{" "}
          <strong className="text-white">{shopLabel}</strong>, read-only.{" "}
        </>
      ) : view.staff.length > 0 ? (
        <>choose whose day to see at <strong className="text-white">{shopLabel}</strong>.{" "}</>
      ) : (
        <>
          <strong className="text-white">{shopLabel}</strong> has no current staff to view.{" "}
        </>
      )}
      <Link to="/dev/dashboard" className={BANNER_LINK}>
        Back to developer dashboard
      </Link>
      {view.shopId && view.staff.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Staff to view">
          {view.staff.map((s) => (
            <li key={s.id}>
              <Link
                to={dashboardHref("/staff", { shopId: view.shopId, staffId: s.id })}
                aria-current={view.viewing?.id === s.id ? "true" : undefined}
                className={`inline-block rounded-md border px-2.5 py-1 text-xs ${
                  view.viewing?.id === s.id
                    ? "border-gold/60 bg-gold/15 text-gold"
                    : "border-white/15 text-white/80 hover:border-gold/40 hover:text-white"
                }`}
              >
                {s.display_name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function StaffLayout() {
  const { user, developerView } = useLoaderData<typeof loader>();
  const isDeveloper = user.role === "developer";
  return (
    <DashboardLayout
      role="staff"
      userName={user.sub}
      shopName={developerView?.shopName ?? undefined}
      showDeveloperViewSwitcher={isDeveloper}
      topBanner={
        developerView ? (
          <div className="py-3">
            <DeveloperBanner view={developerView} />
          </div>
        ) : undefined
      }
    />
  );
}

// Friendly fallback for loader/child-route errors instead of a blank page.
export function ErrorBoundary() {
  return <ErrorScreen />;
}
