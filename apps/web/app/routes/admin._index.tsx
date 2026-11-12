import { useLoaderData, Link } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import {
  Calendar,
  TrendingUp,
  Users,
  Clock,
  ArrowRight,
  CheckCircle,
} from "lucide-react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { formatPence } from "@repo/utils";
import { StatCard } from "~/components/dashboards/StatCard";
import { ShareShopCard } from "~/components/dashboards/ShareShopCard";
import { SetupGate } from "~/components/admin/SetupGate";
import type { SetupStatus } from "~/components/admin/SetupGate";
import { SiteCandidateCard } from "~/components/SiteCandidateCard";
import { formatDate, formatTime as formatUkTime, ukToday } from "~/lib/dateFormat";
import { pageShopId } from "~/lib/pageShop";
import { useShopHref } from "~/lib/useShopHref";

interface AdminStats {
  date: string;
  todays_bookings: number;
  todays_revenue_pence: number;
  active_staff: number;
  waitlist_count: number;
}

interface TodayBooking {
  id: string;
  start_time: string;
  end_time: string;
  status: string;
  customer_name: string;
  service_name: string;
  duration_min: number;
  amount_pence: number;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> =
  {
    pending: {
      bg: "bg-amber-500/10",
      text: "text-amber-400",
      dot: "bg-amber-400",
    },
    confirmed: { bg: "bg-gold/10", text: "text-gold", dot: "bg-gold" },
    in_progress: {
      bg: "bg-blue-500/10",
      text: "text-blue-400",
      dot: "bg-blue-400",
    },
    completed: {
      bg: "bg-emerald-500/10",
      text: "text-emerald-400",
      dot: "bg-emerald-400",
    },
    cancelled: { bg: "bg-red-500/10", text: "text-red-400", dot: "bg-red-400" },
    no_show: { bg: "bg-white/5", text: "text-white/60", dot: "bg-white/30" },
  };

/** "09:05" on the London clock (app/lib/dateFormat.ts). */
function formatTime(iso: string) {
  return formatUkTime(iso, { hour: "2-digit", minute: "2-digit" }) || iso;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  // The admin's own shop; a developer names one with ?shopId=.
  const shopId = pageShopId(request, user);

  let stats: AdminStats = {
    date: ukToday(),
    todays_bookings: 0,
    todays_revenue_pence: 0,
    active_staff: 0,
    waitlist_count: 0,
  };
  let todayBookings: TodayBooking[] = [];

  if (shopId) {
    try {
      stats = await api.get<AdminStats>(`/api/shops/${shopId}/stats`);
    } catch {
      /* use defaults */
    }
    // The API's "today" is the shop's own (London) date; the list matches it.
    const today = /^\d{4}-\d{2}-\d{2}$/.test(stats.date ?? "") ? stats.date : ukToday();

    try {
      const res = await api.get<TodayBooking[]>(
        `/api/shops/${shopId}/bookings?date=${today}`,
      );
      todayBookings = Array.isArray(res) ? res : [];
    } catch {
      /* empty */
    }
  }

  let setupStatus: SetupStatus | null = null;
  if (shopId) {
    try {
      setupStatus = await api.get<SetupStatus>(
        `/api/shops/${shopId}/setup-status`,
      );
    } catch {
      /* non-fatal */
    }
  }

  // Public shop-site URL for the share card. Built from the request origin so
  // staging previews link to themselves rather than production.
  let shopShare: { url: string; name: string } | null = null;
  let shopSlug: string | null = null;
  if (shopId) {
    try {
      const shop = await api.get<{ slug: string; name: string }>(
        `/api/shops/${shopId}`,
      );
      if (shop?.slug) {
        shopSlug = shop.slug;
        shopShare = {
          url: `${new URL(request.url).origin}/${shop.slug}`,
          name: shop.name,
        };
      }
    } catch {
      /* non-fatal: card simply not shown */
    }
  }

  return json({ stats, todayBookings, shopId, setupStatus, shopShare, shopSlug });
}

export default function AdminOverview() {
  const { stats, todayBookings, shopId, setupStatus, shopShare, shopSlug } =
    useLoaderData<typeof loader>();
  const shopHref = useShopHref();

  const upcoming = todayBookings.filter(
    (b) =>
      b.status !== "completed" &&
      b.status !== "cancelled" &&
      b.status !== "no_show",
  );
  const completed = todayBookings.filter((b) => b.status === "completed");

  // Show setup gate until all steps complete
  // The review card is shown in both branches: a shop can have a live site
  // while a setup step (e.g. the Stripe subscription) is still open.
  const reviewCard =
    shopId && shopSlug ? <SiteCandidateCard shopId={shopId} shopSlug={shopSlug} /> : null;

  if (setupStatus && !setupStatus.all_done) {
    return (
      <div className="space-y-8">
        <SetupGate status={setupStatus} />
        {reviewCard}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">
            Overview
          </h1>
          <p className="mt-0.5 text-sm text-white/60">
            {formatDate(new Date(), {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </p>
        </div>
        <Link
          to={shopHref("/admin/bookings")}
          className="flex items-center gap-1.5 text-sm text-gold hover:text-gold/80 transition-colors"
        >
          All bookings <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* A regenerated site waiting for the owner's review (migration 049). */}
      {reviewCard}

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Today's bookings"
          value={stats.todays_bookings}
          icon={Calendar}
        />
        <StatCard
          label="Today's revenue"
          value={formatPence(stats.todays_revenue_pence ?? 0)}
          icon={TrendingUp}
        />
        <StatCard
          label="Staff on shift"
          value={stats.active_staff}
          icon={Users}
        />
        <StatCard label="Waitlist" value={stats.waitlist_count} icon={Clock} />
      </div>

      {/* Share your shop */}
      {shopShare && (
        <ShareShopCard shopUrl={shopShare.url} shopName={shopShare.name} />
      )}

      {/* Today's booking timeline */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-lg font-semibold text-white">
            Today&apos;s schedule
          </h2>
          <span className="text-xs text-white/60">
            {completed.length}/{todayBookings.length} completed
          </span>
        </div>

        {todayBookings.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-white/50">
            No bookings scheduled for today.
          </div>
        ) : (
          <div className="space-y-2">
            {/* Upcoming */}
            {upcoming.length > 0 && (
              <div className="space-y-2">
                {upcoming.map((b) => {
                  const s = STATUS_STYLES[b.status] ?? STATUS_STYLES.pending;
                  return (
                    <div
                      key={b.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/8 bg-dark-100 px-4 py-3 transition-colors hover:border-white/15"
                    >
                      {/* Time */}
                      <div className="w-16 shrink-0 text-center">
                        <p className="text-sm font-semibold text-white">
                          {formatTime(b.start_time)}
                        </p>
                        <p className="text-xs text-white/50">
                          {b.duration_min}m
                        </p>
                      </div>
                      {/* Divider */}
                      <div className="h-10 w-px bg-white/10 shrink-0" />
                      {/* Info */}
                      <div className="min-w-[9rem] flex-1">
                        <p className="text-sm font-medium text-white truncate">
                          {b.customer_name}
                        </p>
                        <p className="text-xs text-white/50 truncate">
                          {b.service_name}
                        </p>
                      </div>
                      {/* Amount + status: right-aligned, on their own line when a phone needs the room */}
                      <div className="ml-auto flex shrink-0 items-center gap-4">
                        <p className="text-sm font-semibold text-gold">
                          {formatPence(b.amount_pence)}
                        </p>
                        <div
                          className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${s.bg} ${s.text}`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                          {b.status.replace("_", " ")}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Completed */}
            {completed.length > 0 && (
              <details className="group">
                <summary className="flex cursor-pointer items-center gap-2 py-2 text-xs text-white/50 hover:text-white/50 list-none">
                  <CheckCircle className="h-3.5 w-3.5" />
                  {completed.length} completed booking
                  {completed.length !== 1 ? "s" : ""}
                </summary>
                <div className="mt-2 space-y-2">
                  {completed.map((b) => (
                    <div
                      key={b.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 opacity-60"
                    >
                      <div className="w-16 shrink-0 text-center">
                        <p className="text-sm font-semibold text-white/70">
                          {formatTime(b.start_time)}
                        </p>
                      </div>
                      <div className="h-10 w-px bg-white/5 shrink-0" />
                      <div className="min-w-[9rem] flex-1">
                        <p className="text-sm font-medium text-white/70 truncate">
                          {b.customer_name}
                        </p>
                        <p className="text-xs text-white/50 truncate">
                          {b.service_name}
                        </p>
                      </div>
                      <div className="ml-auto flex shrink-0 items-center gap-4">
                        <p className="text-sm text-white/50">
                          {formatPence(b.amount_pence)}
                        </p>
                        <div className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
                          <CheckCircle className="h-3 w-3" /> done
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      {/* Quick links */}
      {shopId && (
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            {
              to: "/admin/bookings",
              label: "Manage bookings",
              desc: "View, confirm, complete",
            },
            {
              to: "/admin/services",
              label: "Services",
              desc: "Add or edit services",
            },
            { to: "/admin/staff", label: "Staff", desc: "Manage your team" },
          ].map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className="rounded-xl border border-white/8 bg-dark-100 p-4 transition-colors hover:border-gold/25 hover:bg-dark-100"
            >
              <p className="text-sm font-semibold text-white">{l.label}</p>
              <p className="mt-0.5 text-xs text-white/60">{l.desc}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
