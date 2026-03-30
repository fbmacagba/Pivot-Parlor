import { useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnalyticsData {
  period: { from: string; to: string };
  totals: {
    total_bookings: number;
    total_revenue: number;
    total_commission: number;
    unique_customers: number;
  };
  monthly: { month: string; booking_count: number; gross: number }[];
  peak_hours: { hour: number; booking_count: number }[];
  peak_days: { dow: number; booking_count: number }[];
  status_breakdown: { status: string; count: number }[];
  top_services: { service_name: string; booking_count: number; gross: number }[];
  top_staff: { display_name: string; booking_count: number; gross: number }[];
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  let data: AnalyticsData | null = null;
  if (user.shop_id) {
    try {
      data = await api.get<AnalyticsData>(`/api/shops/${user.shop_id}/analytics`);
    } catch { /* empty */ }
  }

  return json({ data });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAY_LABELS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const STATUS_COLORS: Record<string, string> = {
  completed:  "bg-emerald-500",
  confirmed:  "bg-blue-500",
  pending:    "bg-amber-400",
  cancelled:  "bg-red-400",
  no_show:    "bg-gray-500",
};

function formatMonth(ym: string) {
  const [y, m] = ym.split("-");
  return `${MONTH_LABELS[parseInt(m) - 1]} ${y}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-dark-100 p-5">
      <p className="text-xs text-white/40 font-medium">{label}</p>
      <p className="text-2xl font-bold text-white mt-1">{value}</p>
      {sub && <p className="text-xs text-white/30 mt-0.5">{sub}</p>}
    </div>
  );
}

function BarChart({
  data,
  labelKey,
  valueKey,
  formatLabel,
  formatValue,
  color = "bg-gold",
}: {
  data: Record<string, unknown>[];
  labelKey: string;
  valueKey: string;
  formatLabel?: (v: unknown) => string;
  formatValue?: (v: number) => string;
  color?: string;
}) {
  const max = Math.max(...data.map(d => Number(d[valueKey])), 1);
  return (
    <div className="flex items-end gap-1 h-28">
      {data.map((d, i) => {
        const val = Number(d[valueKey]);
        const pct = (val / max) * 100;
        const label = formatLabel ? formatLabel(d[labelKey]) : String(d[labelKey]);
        const valStr = formatValue ? formatValue(val) : String(val);
        return (
          <div key={i} className="group relative flex flex-1 flex-col items-center gap-1">
            {/* Tooltip */}
            <div className="absolute bottom-full mb-1 hidden group-hover:flex flex-col items-center z-10">
              <div className="rounded bg-dark-100 border border-white/15 px-2 py-1 text-xs text-white whitespace-nowrap shadow-lg">
                {label}: {valStr}
              </div>
            </div>
            <div
              className={`w-full rounded-t ${color} opacity-80 hover:opacity-100 transition-opacity`}
              style={{ height: `${Math.max(pct, 2)}%` }}
            />
            <span className="text-[9px] text-white/30 leading-none">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminAnalytics() {
  const { data } = useLoaderData<typeof loader>();

  if (!data) {
    return (
      <div className="space-y-4">
        <h1 className="font-heading text-2xl font-bold text-white">Analytics</h1>
        <div className="rounded-xl border border-dashed border-white/10 p-12 text-center text-white/30">
          No data yet. Analytics will appear once bookings are made.
        </div>
      </div>
    );
  }

  const { totals, monthly, peak_hours, peak_days, status_breakdown, top_services, top_staff } = data;
  const net = totals.total_revenue - totals.total_commission;

  // Fill all 12 months for trend chart (include zeros)
  const now = new Date();
  const allMonths = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const found = monthly.find(m => m.month === key);
    return { month: key, booking_count: found?.booking_count ?? 0, gross: found?.gross ?? 0 };
  });

  // Fill all 24 hours
  const allHours = Array.from({ length: 24 }, (_, h) => {
    const found = peak_hours.find(p => p.hour === h);
    return { hour: h, booking_count: found?.booking_count ?? 0 };
  });

  // Fill all 7 days (Mon-Sun order)
  const allDays = [1,2,3,4,5,6,0].map(dow => {
    const found = peak_days.find(p => p.dow === dow);
    return { dow, booking_count: found?.booking_count ?? 0 };
  });

  const totalStatusCount = status_breakdown.reduce((s, r) => s + r.count, 0);

  return (
    <div className="space-y-8">

      {/* Header */}
      <div>
        <h1 className="font-heading text-2xl font-bold text-white">Analytics</h1>
        <p className="mt-0.5 text-sm text-white/40">
          Last 12 months · {data.period.from} to {data.period.to}
        </p>
      </div>

      {/* All-time totals */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total bookings" value={totals.total_bookings.toLocaleString()} sub="all time" />
        <StatCard label="Total revenue" value={`£${totals.total_revenue.toFixed(2)}`} sub="completed bookings" />
        <StatCard label="Net earnings" value={`£${net.toFixed(2)}`} sub={`after £${totals.total_commission.toFixed(2)} commission`} />
        <StatCard label="Unique customers" value={totals.unique_customers.toLocaleString()} sub="all time" />
      </div>

      {/* Monthly trend */}
      <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-base font-semibold text-white mb-1">Monthly bookings</h2>
        <p className="text-xs text-white/40 mb-5">Completed bookings over the last 12 months</p>
        <BarChart
          data={allMonths}
          labelKey="month"
          valueKey="booking_count"
          formatLabel={v => formatMonth(String(v)).slice(0, 3)}
          color="bg-gold"
        />
      </div>

      {/* Revenue trend */}
      <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-base font-semibold text-white mb-1">Monthly revenue</h2>
        <p className="text-xs text-white/40 mb-5">Gross revenue (£) over the last 12 months</p>
        <BarChart
          data={allMonths}
          labelKey="month"
          valueKey="gross"
          formatLabel={v => formatMonth(String(v)).slice(0, 3)}
          formatValue={v => `£${v.toFixed(0)}`}
          color="bg-emerald-500"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">

        {/* Peak hours */}
        <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-base font-semibold text-white mb-1">Peak hours</h2>
          <p className="text-xs text-white/40 mb-5">When customers book most (all time)</p>
          <BarChart
            data={allHours}
            labelKey="hour"
            valueKey="booking_count"
            formatLabel={v => {
              const h = Number(v);
              return h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h-12}p`;
            }}
            color="bg-blue-500"
          />
        </div>

        {/* Peak days */}
        <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-base font-semibold text-white mb-1">Peak days</h2>
          <p className="text-xs text-white/40 mb-5">Busiest days of the week (all time)</p>
          <BarChart
            data={allDays}
            labelKey="dow"
            valueKey="booking_count"
            formatLabel={v => DAY_LABELS[Number(v)]}
            color="bg-purple-500"
          />
        </div>

      </div>

      <div className="grid gap-6 lg:grid-cols-3">

        {/* Status breakdown */}
        <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-base font-semibold text-white mb-4">Booking status</h2>
          <div className="space-y-3">
            {status_breakdown.sort((a,b) => b.count - a.count).map(s => {
              const pct = totalStatusCount > 0 ? Math.round((s.count / totalStatusCount) * 100) : 0;
              return (
                <div key={s.status}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-white/60 capitalize">{s.status.replace("_"," ")}</span>
                    <span className="text-white/40">{s.count} ({pct}%)</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${STATUS_COLORS[s.status] ?? "bg-white/30"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Top services */}
        <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-base font-semibold text-white mb-4">Top services</h2>
          {top_services.length === 0 ? (
            <p className="text-sm text-white/30">No data yet.</p>
          ) : (
            <div className="space-y-3">
              {top_services.map((s, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs text-white/25 w-4 shrink-0">{i+1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{s.service_name}</p>
                    <p className="text-xs text-white/40">{s.booking_count} bookings</p>
                  </div>
                  <span className="text-sm font-semibold text-gold shrink-0">£{s.gross.toFixed(0)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top staff */}
        <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-base font-semibold text-white mb-4">Top staff</h2>
          {top_staff.length === 0 ? (
            <p className="text-sm text-white/30">No data yet.</p>
          ) : (
            <div className="space-y-3">
              {top_staff.map((s, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs text-white/25 w-4 shrink-0">{i+1}</span>
                  <div className="w-7 h-7 rounded-full bg-gold/20 flex items-center justify-center text-xs font-bold text-gold shrink-0">
                    {s.display_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{s.display_name}</p>
                    <p className="text-xs text-white/40">{s.booking_count} bookings</p>
                  </div>
                  <span className="text-sm font-semibold text-gold shrink-0">£{s.gross.toFixed(0)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
