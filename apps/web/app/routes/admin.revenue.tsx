import { useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { TrendingUp, PoundSterling, BarChart2, Users } from "lucide-react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { formatPence } from "@repo/utils";
import { StatCard } from "~/components/dashboards/StatCard";

interface Summary { booking_count: number; gross_pence: number; commission_pence: number }
interface ByStaff  { staff_id: string; display_name: string; booking_count: number; gross_pence: number; commission_pence: number }
interface ByService{ service_id: string; service_name: string; booking_count: number; gross_pence: number }
interface Daily    { booking_date: string; booking_count: number; gross_pence: number; commission_pence: number }

interface RevenueData {
  year: number; month: number;
  summary: Summary;
  by_staff: ByStaff[];
  by_service: ByService[];
  daily: Daily[];
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function pad(n: number) { return String(n).padStart(2, "0"); }

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = user.shop_id;

  const url = new URL(request.url);
  const now = new Date();
  const year  = Number(url.searchParams.get("year")  ?? now.getFullYear());
  const month = Number(url.searchParams.get("month") ?? (now.getMonth() + 1));

  let data: RevenueData | null = null;
  if (shopId) {
    try {
      data = await api.get<RevenueData>(
        `/api/shops/${shopId}/revenue?year=${year}&month=${month}`
      );
    } catch { /* empty */ }
  }

  return json({ data, year, month, shopId });
}

export default function AdminRevenue() {
  const { data, year, month } = useLoaderData<typeof loader>();
  const now = new Date();

  const s = data?.summary ?? { booking_count: 0, gross_pence: 0, commission_pence: 0 };
  const net_pence = s.gross_pence - s.commission_pence;

  // Build month selector options — current month back 12 months
  const monthOptions: { year: number; month: number; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthOptions.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
  }

  // Chart: max gross for bar scale
  const daily = data?.daily ?? [];
  const maxGross = Math.max(...daily.map(d => d.gross_pence), 1);

  return (
    <div className="space-y-8">
      {/* Header + month selector */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Revenue</h1>
          <p className="mt-0.5 text-sm text-white/40">{MONTHS[month - 1]} {year}</p>
        </div>
        <form method="get">
          <select
            name="period"
            defaultValue={`${year}-${pad(month)}`}
            onChange={e => {
              const [y, m] = e.target.value.split("-");
              window.location.href = `/admin/revenue?year=${y}&month=${m}`;
            }}
            className="rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
          >
            {monthOptions.map(o => (
              <option key={`${o.year}-${o.month}`} value={`${o.year}-${pad(o.month)}`} className="bg-dark">
                {o.label}
              </option>
            ))}
          </select>
        </form>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Gross bookings"    value={formatPence(s.gross_pence)}      icon={TrendingUp} />
        <StatCard label="Net earnings"      value={formatPence(net_pence)}           icon={PoundSterling} />
        <StatCard label="Platform commission" value={formatPence(s.commission_pence)} icon={BarChart2} />
        <StatCard label="Completed bookings"  value={s.booking_count}              icon={Users} />
      </div>

      {/* Daily chart */}
      {daily.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-base font-semibold text-white mb-4">Daily revenue — {MONTHS[month - 1]}</h2>
          <div className="flex items-end gap-1 h-32">
            {daily.map(d => {
              const pct = (d.gross_pence / maxGross) * 100;
              const day = d.booking_date.slice(8);
              return (
                <div key={d.booking_date} className="group relative flex flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t bg-gold/60 hover:bg-gold transition-colors"
                    style={{ height: `${Math.max(pct, 2)}%` }}
                    title={formatPence(d.gross_pence)}
                  />
                  {/* Tooltip */}
                  <div className="absolute bottom-full mb-1 hidden group-hover:flex flex-col items-center">
                    <div className="rounded bg-dark-100 border border-white/15 px-2 py-1 text-xs text-white whitespace-nowrap shadow-lg">
                      {day} {MONTHS[month - 1]}<br />{formatPence(d.gross_pence)} · {d.booking_count} bookings
                    </div>
                  </div>
                  {parseInt(day) % 5 === 0 && (
                    <span className="text-[10px] text-white/30">{day}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Per-staff */}
      {(data?.by_staff ?? []).length > 0 && (
        <div className="rounded-xl border border-white/10 bg-dark-100 overflow-x-auto">
          <div className="px-5 py-4 border-b border-white/10">
            <h2 className="font-heading text-base font-semibold text-white">Revenue by staff</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10">
                {["Staff member","Bookings","Gross","Commission","Net"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-white/40 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(data?.by_staff ?? []).map(r => (
                <tr key={r.staff_id} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3 font-medium text-white">{r.display_name}</td>
                  <td className="px-4 py-3 text-white/60">{r.booking_count}</td>
                  <td className="px-4 py-3 text-gold font-semibold">{formatPence(r.gross_pence)}</td>
                  <td className="px-4 py-3 text-white/50">{formatPence(r.commission_pence)}</td>
                  <td className="px-4 py-3 text-white">{formatPence(r.gross_pence - r.commission_pence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-service */}
      {(data?.by_service ?? []).length > 0 && (
        <div className="rounded-xl border border-white/10 bg-dark-100 overflow-x-auto">
          <div className="px-5 py-4 border-b border-white/10">
            <h2 className="font-heading text-base font-semibold text-white">Revenue by service</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10">
                {["Service","Bookings","Revenue"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-white/40 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(data?.by_service ?? []).map(r => (
                <tr key={r.service_id} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3 font-medium text-white">{r.service_name}</td>
                  <td className="px-4 py-3 text-white/60">{r.booking_count}</td>
                  <td className="px-4 py-3 text-gold font-semibold">{formatPence(r.gross_pence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!data && (
        <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-white/30">
          No revenue data for this period.
        </div>
      )}
    </div>
  );
}
