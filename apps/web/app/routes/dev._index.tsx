import { data as json, Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { BarChart3, MessageSquare, ShoppingBag, Sparkles, TrendingUp } from "lucide-react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { formatPence } from "@repo/utils";
import { ErrorScreen } from "~/components/ErrorScreen";
import { StatCard } from "~/components/dashboards/StatCard";
import { AlertTestButton } from "~/components/dashboards/AlertTestButton";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { LoadError } from "~/components/ui/LoadError";
import { formatDateTime } from "~/lib/dateFormat";
import { pageTitle } from "~/lib/pageTitle";

export const meta = () => pageTitle("Overview");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/dev" homeLabel="Back to overview" />;
}

interface DevStats {
  total_shops: number;
  bookings_this_month: number;
  platform_commission_pence: number;
  pending_enquiries: number;
  /** Absent from an API worker deployed before these were added. */
  ai_calls_this_month?: number;
  ai_cost_usd_this_month?: number;
}

/** "$12.34": the AI cost log is an estimate in US dollars, as vendors price it. */
function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" }).format(
    amount,
  );
}

interface EnquiryRow {
  id: string;
  full_name: string;
  shop_name: string;
  shop_type: string;
  email: string;
  phone?: string | null;
  message?: string | null;
  created_at: string;
  onboarded_at?: string | null;
}

/** How many of the newest enquiries the overview shows. */
const RECENT_ENQUIRIES = 8;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "developer", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  // Two independent reads, sent together. Each keeps its own failure flag: a
  // figure that could not be read is never shown as a real-looking zero.
  const [statsR, enquiriesR] = await Promise.allSettled([
    api.get<DevStats>("/api/dev/stats"),
    api.get<EnquiryRow[]>(`/api/contact?limit=${RECENT_ENQUIRIES}`),
  ]);

  const stats = statsR.status === "fulfilled" && statsR.value ? statsR.value : null;
  const enquiriesOk = enquiriesR.status === "fulfilled" && Array.isArray(enquiriesR.value);
  return json({
    stats,
    recentEnquiries: enquiriesOk ? enquiriesR.value.slice(0, RECENT_ENQUIRIES) : [],
    enquiriesError: !enquiriesOk,
  });
}

export default function DevOverview() {
  const { stats, recentEnquiries, enquiriesError } = useLoaderData<typeof loader>();

  return (
    <div>
      <h1 className="mb-6 font-heading text-2xl font-bold text-white">Overview</h1>
      {stats ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard label="Active shops" value={stats.total_shops} icon={ShoppingBag} />
          <StatCard label="Completed bookings this month" value={stats.bookings_this_month} icon={BarChart3} />
          <StatCard
            label="Commission this month"
            value={formatPence(stats.platform_commission_pence)}
            icon={TrendingUp}
          />
          <StatCard label="Enquiries not yet onboarded" value={stats.pending_enquiries} icon={MessageSquare} />
          {typeof stats.ai_cost_usd_this_month === "number" && (
            <>
              <StatCard
                label="Estimated AI spend this month"
                value={formatUsd(stats.ai_cost_usd_this_month)}
                icon={Sparkles}
              />
              <StatCard label="AI calls this month" value={stats.ai_calls_this_month ?? 0} icon={Sparkles} />
            </>
          )}
        </div>
      ) : (
        <LoadError what="the platform figures" />
      )}

      <section className="mt-10" aria-labelledby="recent-enquiries-heading">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 id="recent-enquiries-heading" className="font-heading text-lg font-semibold text-white">
            Recent site enquiries
          </h2>
          <Link to="/dev/enquiries" className="tap-target inline-flex items-center text-sm font-medium text-gold hover:underline">
            View all enquiries
          </Link>
        </div>
        {enquiriesError ? (
          <LoadError what="the recent enquiries" />
        ) : recentEnquiries.length === 0 ? (
          <p className="rounded-xl border border-white/10 bg-dark-100 px-4 py-8 text-center text-sm text-white/60">
            No enquiries yet.{" "}
            <Link to="/contact" className="text-gold hover:underline">
              Contact form
            </Link>{" "}
            submissions appear here.
          </p>
        ) : (
          <ul className="divide-y divide-white/5 rounded-xl border border-white/10 bg-dark-100">
            {recentEnquiries.map((e) => (
              <li
                key={e.id}
                className="grid gap-x-4 gap-y-1 px-4 py-4 hover:bg-white/[0.02] sm:px-5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_auto] md:items-center"
              >
                <div className="min-w-0">
                  <p className="font-medium text-white">{e.full_name}</p>
                  <p className="text-sm text-white/70">
                    {e.shop_name}
                    <span className="capitalize text-white/60"> · {e.shop_type.replace(/_/g, " ")}</span>
                  </p>
                </div>
                <div className="min-w-0 text-sm">
                  <p className="break-all text-white/80">{e.email}</p>
                  <p className="text-white/60">{e.phone || "No phone given"}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 md:flex-col md:items-end md:gap-1">
                  {e.onboarded_at ? (
                    <StatusBadge status="active" label="Onboarded" />
                  ) : (
                    <StatusBadge status="open" label="Not onboarded" />
                  )}
                  <span className="whitespace-nowrap text-xs text-white/60">{formatDateTime(e.created_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AlertTestButton />
    </div>
  );
}
