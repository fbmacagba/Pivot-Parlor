import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useLoaderData } from "@remix-run/react";
import { BarChart3, MessageSquare, ShoppingBag, TrendingUp } from "lucide-react";
import { getSessionToken } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { formatPence } from "@repo/utils";
import { StatCard } from "~/components/dashboards/StatCard";

interface DevStats {
  total_shops: number;
  bookings_this_month: number;
  platform_commission_pence: number;
  pending_enquiries: number;
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
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  let stats: DevStats = {
    total_shops: 0,
    bookings_this_month: 0,
    platform_commission_pence: 0,
    pending_enquiries: 0,
  };

  let recentEnquiries: EnquiryRow[] = [];

  try {
    stats = await api.get<DevStats>("/api/dev/stats");
  } catch {
    // use defaults — API may not have this endpoint yet
  }

  try {
    const all = await api.get<EnquiryRow[]>("/api/contact");
    recentEnquiries = Array.isArray(all) ? all.slice(0, 8) : [];
  } catch {
    recentEnquiries = [];
  }

  return json({ stats, recentEnquiries });
}

export default function DevOverview() {
  const { stats, recentEnquiries } = useLoaderData<typeof loader>();

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-white mb-6">Overview</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total shops active"
          value={stats.total_shops}
          icon={ShoppingBag}
        />
        <StatCard
          label="Bookings this month"
          value={stats.bookings_this_month}
          icon={BarChart3}
        />
        <StatCard
          label="Platform commission"
          value={formatPence(stats.platform_commission_pence)}
          icon={TrendingUp}
        />
        <StatCard
          label="Pending enquiries"
          value={stats.pending_enquiries}
          icon={MessageSquare}
        />
      </div>

      <section className="mt-10">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 className="font-heading text-lg font-semibold text-white">Recent site enquiries</h2>
          <Link
            to="/dev/enquiries"
            className="text-sm font-medium text-gold hover:text-gold/80"
          >
            View all →
          </Link>
        </div>
        <div className="rounded-xl border border-white/10 bg-dark-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10">
                {["Name", "Shop", "Type", "Email", "Phone", "Submitted"].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-semibold text-white/60 uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {recentEnquiries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-white/60">
                    No enquiries yet.{" "}
                    <Link to="/contact" className="text-gold hover:underline">
                      Contact form
                    </Link>{" "}
                    submissions appear here.
                  </td>
                </tr>
              ) : (
                recentEnquiries.map((e) => (
                  <tr key={e.id} className="hover:bg-white/2">
                    <td className="px-4 py-3 font-medium text-white">{e.full_name}</td>
                    <td className="px-4 py-3 text-white/70">{e.shop_name}</td>
                    <td className="px-4 py-3 text-white/60 capitalize">{e.shop_type.replace(/_/g, " ")}</td>
                    <td className="px-4 py-3 text-white/60">{e.email}</td>
                    <td className="px-4 py-3 text-white/50 text-xs">{e.phone || "—"}</td>
                    <td className="px-4 py-3 text-white/60 text-xs whitespace-nowrap">
                      {new Date(e.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
