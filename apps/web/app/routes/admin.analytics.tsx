import { useLoaderData, data as json } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { formatPence } from "@repo/utils";
import { formatCount, ukParts } from "~/lib/dateFormat";
import { pageShopId } from "~/lib/pageShop";
import { pageTitle } from "~/lib/pageTitle";
import { LoadError } from "~/components/ui/LoadError";
import { statusLabel } from "~/components/ui/StatusBadge";
import { ErrorScreen } from "~/components/ErrorScreen";

export const meta = () => pageTitle("Analytics");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnalyticsData {
  period: { from: string; to: string };
  totals: {
    total_bookings: number;
    total_revenue_pence: number;
    total_commission_pence: number;
    unique_customers: number;
  };
  monthly: { month: string; booking_count: number; gross_pence: number }[];
  peak_hours: { hour: number; booking_count: number }[];
  peak_days: { dow: number; booking_count: number }[];
  status_breakdown: { status: string; count: number }[];
  top_services: { service_name: string; booking_count: number; gross_pence: number }[];
  top_staff: { display_name: string; booking_count: number; gross_pence: number }[];
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  const shopId = pageShopId(request, user);

  let data: AnalyticsData | null = null;
  let loadError = false;
  if (shopId) {
    try {
      data = await api.get<AnalyticsData>(`/api/shops/${shopId}/analytics`);
    } catch {
      loadError = true;
    }
  }

  return json({ data, shopId, loadError });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAY_LABELS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// The status tokens (DESIGN.md, "Status mapping"). Each bar also carries its
// status name and count as text, so colour is never the only signal.
const STATUS_COLORS: Record<string, string> = {
  pending:     "bg-amber-400",
  confirmed:   "bg-emerald-400",
  in_progress: "bg-gold",
  completed:   "bg-white/40",
  cancelled:   "bg-red-400",
  no_show:     "bg-white/20",
};

function formatMonth(ym: string) {
  const [y, m] = ym.split("-");
  return `${MONTH_LABELS[parseInt(m) - 1]} ${y}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-dark-100 p-5">
      <p className="text-xs text-white/60 font-medium">{label}</p>
      <p className="text-2xl font-bold text-white mt-1">{value}</p>
      {sub && <p className="text-xs text-white/60 mt-0.5">{sub}</p>}
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
  labelStep = 1,
  compactLabelStep = labelStep,
}: {
  data: Record<string, unknown>[];
  labelKey: string;
  valueKey: string;
  formatLabel?: (v: unknown) => string;
  formatValue?: (v: number) => string;
  color?: string;
  /** Show only every Nth axis label, so a dense chart (24 hours) keeps readable labels instead of tiny ones. */
  labelStep?: number;
  /** Below sm, thin the labels further. Every bar still names itself on focus, hover or press. */
  compactLabelStep?: number;
}) {
  const max = Math.max(...data.map(d => Number(d[valueKey])), 1);
  return (
    <div className="flex h-32 gap-1">
      {data.map((d, i) => {
        const val = Number(d[valueKey]);
        const pct = (val / max) * 100;
        const label = formatLabel ? formatLabel(d[labelKey]) : String(d[labelKey]);
        const valStr = formatValue ? formatValue(val) : String(val);
        return (
          <div
            key={i}
            role="img"
            aria-label={`${label}: ${valStr}`}
            tabIndex={0}
            className="group relative flex h-full min-w-0 flex-1 flex-col items-center gap-1 rounded outline-none focus-visible:ring-1 focus-visible:ring-gold/60"
          >
            {/* Tooltip: hover on pointer devices, tap or keyboard focus elsewhere */}
            <div className="absolute bottom-full mb-1 hidden group-hover:flex group-focus:flex group-active:flex flex-col items-center z-10">
              <div className="rounded bg-dark-100 border border-white/15 px-2 py-1 text-xs text-white whitespace-nowrap shadow-lg">
                {label}: {valStr}
              </div>
            </div>
            {/* The wrapper is the bar's definite height reference; the bar grows up from its bottom edge */}
            <div className="flex w-full flex-1 items-end">
              <div
                className={`w-full rounded-t ${color} opacity-80 hover:opacity-100 transition-opacity`}
                style={{ height: `${Math.max(pct, 2)}%` }}
              />
            </div>
            {/* Zero width, so a label may run past its own bar; the ones thinned out leave room for it */}
            <span
              aria-hidden
              className={`flex h-4 w-0 justify-center whitespace-nowrap text-xs leading-none text-white/60 ${
                i % labelStep !== 0 ? "invisible" : i % compactLabelStep !== 0 ? "invisible sm:visible" : ""
              }`}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminAnalytics() {
  const { data, loadError } = useLoaderData<typeof loader>();

  if (!data) {
    return (
      <div className="space-y-4">
        <h1 className="font-heading text-2xl font-bold text-white">Analytics</h1>
        {loadError ? (
          <LoadError what="your analytics" />
        ) : (
          <div className="rounded-xl border border-dashed border-white/10 p-12 text-center text-sm text-white/60">
            No data yet. Analytics will appear once bookings are made.
          </div>
        )}
      </div>
    );
  }

  const { totals, monthly, peak_hours, peak_days, status_breakdown, top_services, top_staff } = data;
  const net_pence = totals.total_revenue_pence - totals.total_commission_pence;

  // Fill all 12 months for trend chart (include zeros), ending with this
  // month in London so the server and the browser draw the same months.
  const { year: nowYear, month: nowMonth } = ukParts();
  const allMonths = Array.from({ length: 12 }, (_, i) => {
    const index = nowYear * 12 + (nowMonth - 1) - 11 + i;
    const key = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
    const found = monthly.find(m => m.month === key);
    return { month: key, booking_count: found?.booking_count ?? 0, gross_pence: found?.gross_pence ?? 0 };
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
  // A copy: sorting in place would reorder the loader's own data during render.
  const statusRows = [...status_breakdown].sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-8">

      {/* Header */}
      <div>
        <h1 className="font-heading text-2xl font-bold text-white">Analytics</h1>
        <p className="mt-0.5 text-sm text-white/60">
          Last 12 months · {data.period.from} to {data.period.to}
        </p>
      </div>

      {/* All-time totals */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total bookings" value={formatCount(totals.total_bookings)} sub="all time" />
        <StatCard label="Total revenue" value={formatPence(totals.total_revenue_pence)} sub="completed bookings" />
        <StatCard label="Net earnings" value={formatPence(net_pence)} sub={`after ${formatPence(totals.total_commission_pence)} commission`} />
        <StatCard label="Unique customers" value={formatCount(totals.unique_customers)} sub="all time" />
      </div>

      {/* Monthly trend */}
      <div className="min-w-0 rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-base font-semibold text-white mb-1">Monthly bookings</h2>
        <p className="text-xs text-white/60 mb-5">Completed bookings over the last 12 months</p>
        <BarChart
          data={allMonths}
          labelKey="month"
          valueKey="booking_count"
          formatLabel={v => formatMonth(String(v)).slice(0, 3)}
          color="bg-gold"
          compactLabelStep={2}
        />
      </div>

      {/* Revenue trend */}
      <div className="min-w-0 rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-base font-semibold text-white mb-1">Monthly revenue</h2>
        <p className="text-xs text-white/60 mb-5">Gross revenue over the last 12 months</p>
        <BarChart
          data={allMonths}
          labelKey="month"
          valueKey="gross_pence"
          formatLabel={v => formatMonth(String(v)).slice(0, 3)}
          formatValue={v => formatPence(v)}
          color="bg-emerald-400"
          compactLabelStep={2}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">

        {/* Peak hours */}
        <div className="min-w-0 rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-base font-semibold text-white mb-1">Peak hours</h2>
          <p className="text-xs text-white/60 mb-5">When customers book most (all time)</p>
          <BarChart
            data={allHours}
            labelKey="hour"
            valueKey="booking_count"
            formatLabel={v => {
              const h = Number(v);
              return h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h-12}p`;
            }}
            color="bg-white/60"
            labelStep={3}
            compactLabelStep={6}
          />
        </div>

        {/* Peak days */}
        <div className="min-w-0 rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-base font-semibold text-white mb-1">Peak days</h2>
          <p className="text-xs text-white/60 mb-5">Busiest days of the week (all time)</p>
          <BarChart
            data={allDays}
            labelKey="dow"
            valueKey="booking_count"
            formatLabel={v => DAY_LABELS[Number(v)]}
            color="bg-amber-400"
          />
        </div>

      </div>

      <div className="grid gap-6 lg:grid-cols-3">

        {/* Status breakdown */}
        <div className="min-w-0 rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-base font-semibold text-white mb-4">Booking status</h2>
          <div className="space-y-3">
            {statusRows.map(s => {
              const pct = totalStatusCount > 0 ? Math.round((s.count / totalStatusCount) * 100) : 0;
              return (
                <div key={s.status}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-white/80">{statusLabel(s.status)}</span>
                    <span className="text-white/60">{s.count} ({pct}%)</span>
                  </div>
                  <div aria-hidden className="h-1.5 rounded-full bg-white/10 overflow-hidden">
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
        <div className="min-w-0 rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-base font-semibold text-white mb-4">Top services</h2>
          {top_services.length === 0 ? (
            <p className="text-sm text-white/60">No data yet.</p>
          ) : (
            <div className="space-y-3">
              {top_services.map((s, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs text-white/60 w-4 shrink-0">{i+1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{s.service_name}</p>
                    <p className="text-xs text-white/60">{s.booking_count} bookings</p>
                  </div>
                  <span className="text-sm font-semibold text-gold shrink-0">{formatPence(s.gross_pence)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top staff */}
        <div className="min-w-0 rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-base font-semibold text-white mb-4">Top staff</h2>
          {top_staff.length === 0 ? (
            <p className="text-sm text-white/60">No data yet.</p>
          ) : (
            <div className="space-y-3">
              {top_staff.map((s, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs text-white/60 w-4 shrink-0">{i+1}</span>
                  <div className="w-7 h-7 rounded-full bg-gold/20 flex items-center justify-center text-xs font-bold text-gold shrink-0">
                    {s.display_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{s.display_name}</p>
                    <p className="text-xs text-white/60">{s.booking_count} bookings</p>
                  </div>
                  <span className="text-sm font-semibold text-gold shrink-0">{formatPence(s.gross_pence)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
