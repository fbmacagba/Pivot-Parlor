import { useLoaderData, Link, data as json } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
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
import { pageTitle } from "~/lib/pageTitle";
import { useShopHref } from "~/lib/useShopHref";
import { LoadError } from "~/components/ui/LoadError";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { ErrorScreen } from "~/components/ErrorScreen";

export const meta = () => pageTitle("Overview");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

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
  let statsError = false;
  let bookingsError = false;
  let setupStatus: SetupStatus | null = null;
  // Public shop-site URL for the share card. Built from the request origin so
  // staging previews link to themselves rather than production.
  let shopShare: { url: string; name: string } | null = null;
  let shopSlug: string | null = null;

  if (shopId) {
    // Today's bookings need the shop's own date from the stats, so they
    // follow it; the setup status and the shop load alongside both.
    const statsAndBookings = (async () => {
      try {
        stats = await api.get<AdminStats>(`/api/shops/${shopId}/stats`);
      } catch {
        statsError = true;
      }
      // The API's "today" is the shop's own (London) date; the list matches it.
      const today = /^\d{4}-\d{2}-\d{2}$/.test(stats.date ?? "") ? stats.date : ukToday();
      try {
        const res = await api.get<TodayBooking[]>(
          `/api/shops/${shopId}/bookings?date=${today}`,
        );
        todayBookings = Array.isArray(res) ? res : [];
      } catch {
        bookingsError = true;
      }
    })();

    const [, setupRes, shopRes] = await Promise.allSettled([
      statsAndBookings,
      api.get<SetupStatus>(`/api/shops/${shopId}/setup-status`),
      api.get<{ slug: string; name: string }>(`/api/shops/${shopId}`),
    ]);
    // Non-fatal: without it the overview shows instead of the setup steps.
    if (setupRes.status === "fulfilled") setupStatus = setupRes.value;
    // Non-fatal: the share card is simply not shown.
    if (shopRes.status === "fulfilled" && shopRes.value?.slug) {
      shopSlug = shopRes.value.slug;
      shopShare = {
        url: `${new URL(request.url).origin}/${shopRes.value.slug}`,
        name: shopRes.value.name,
      };
    }
  }

  return json({ stats, todayBookings, shopId, setupStatus, shopShare, shopSlug, statsError, bookingsError });
}

export default function AdminOverview() {
  const { stats, todayBookings, shopId, setupStatus, shopShare, shopSlug, statsError, bookingsError } =
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
      <div className="flex flex-wrap items-center justify-between gap-3">
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
          className="tap-target flex items-center gap-1.5 text-sm text-gold hover:text-gold/80 transition-colors"
        >
          All bookings <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      {/* A regenerated site waiting for the owner's review (migration 049). */}
      {reviewCard}

      {/* Stats */}
      {statsError ? (
        <LoadError what="today's figures" />
      ) : (
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
      )}

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
          {!bookingsError && (
            <span className="text-xs text-white/60">
              {completed.length} of {todayBookings.length} completed
            </span>
          )}
        </div>

        {bookingsError ? (
          <LoadError what="today's bookings" />
        ) : todayBookings.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-white/60">
            No bookings scheduled for today.
          </div>
        ) : (
          <div className="space-y-2">
            {/* Upcoming */}
            {upcoming.length > 0 && (
              <div className="space-y-2">
                {upcoming.map((b) => {
                  return (
                    <div
                      key={b.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-dark-100 px-4 py-3 transition-colors hover:border-white/15"
                    >
                      {/* Time */}
                      <div className="w-16 shrink-0 text-center">
                        <p className="text-sm font-semibold text-white">
                          {formatTime(b.start_time)}
                        </p>
                        <p className="text-xs text-white/60">
                          {b.duration_min} min
                        </p>
                      </div>
                      {/* Divider */}
                      <div aria-hidden className="h-10 w-px bg-white/10 shrink-0" />
                      {/* Info */}
                      <div className="min-w-[9rem] flex-1">
                        <p className="text-sm font-medium text-white truncate">
                          {b.customer_name}
                        </p>
                        <p className="text-xs text-white/60 truncate">
                          {b.service_name}
                        </p>
                      </div>
                      {/* Amount + status: right-aligned, on their own line when a phone needs the room */}
                      <div className="ml-auto flex shrink-0 items-center gap-4">
                        <p className="text-sm font-semibold text-gold">
                          {formatPence(b.amount_pence)}
                        </p>
                        <StatusBadge status={b.status} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Completed */}
            {completed.length > 0 && (
              <details className="group">
                <summary className="tap-target flex cursor-pointer items-center gap-2 py-2 text-xs text-white/70 hover:text-white list-none">
                  <CheckCircle className="h-3.5 w-3.5" aria-hidden />
                  {completed.length} completed booking
                  {completed.length !== 1 ? "s" : ""}
                </summary>
                <div className="mt-2 space-y-2">
                  {completed.map((b) => (
                    <div
                      key={b.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3"
                    >
                      <div className="w-16 shrink-0 text-center">
                        <p className="text-sm font-semibold text-white/70">
                          {formatTime(b.start_time)}
                        </p>
                      </div>
                      <div aria-hidden className="h-10 w-px bg-white/5 shrink-0" />
                      <div className="min-w-[9rem] flex-1">
                        <p className="text-sm font-medium text-white/70 truncate">
                          {b.customer_name}
                        </p>
                        <p className="text-xs text-white/60 truncate">
                          {b.service_name}
                        </p>
                      </div>
                      <div className="ml-auto flex shrink-0 items-center gap-4">
                        <p className="text-sm text-white/60">
                          {formatPence(b.amount_pence)}
                        </p>
                        <StatusBadge status="completed" />
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
              to={shopHref(l.to)}
              className="rounded-xl border border-white/10 bg-dark-100 p-4 transition-colors hover:border-gold/25 hover:bg-dark-100"
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
