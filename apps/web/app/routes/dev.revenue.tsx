import { useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { StatCard } from "~/components/dashboards/StatCard";
import { TrendingUp, BarChart2, ShoppingBag, PoundSterling } from "lucide-react";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function pad(n: number) { return String(n).padStart(2, "0"); }

interface ShopRow { shop_id: string; shop_name: string; booking_count: number; gross: number; commission: number }
interface Totals   { total_bookings: number; total_gross: number; total_commission: number }
interface RevenueData { year: number; month: number; totals: Totals; shops: ShopRow[] }

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "developer", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  const url = new URL(request.url);
  const now = new Date();
  const year  = Number(url.searchParams.get("year")  ?? now.getFullYear());
  const month = Number(url.searchParams.get("month") ?? (now.getMonth() + 1));

  let data: RevenueData | null = null;
  try {
    data = await api.get<RevenueData>(`/api/dev/revenue?year=${year}&month=${month}`);
  } catch { /* empty */ }

  return json({ data, year, month });
}

export default function DevRevenue() {
  const { data, year, month } = useLoaderData<typeof loader>();
  const now = new Date();

  const t = data?.totals ?? { total_bookings: 0, total_gross: 0, total_commission: 0 };

  const monthOptions: { year: number; month: number; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthOptions.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Platform Revenue</h1>
          <p className="mt-0.5 text-sm text-white/40">{MONTHS[month - 1]} {year}</p>
        </div>
        <select
          defaultValue={`${year}-${pad(month)}`}
          onChange={e => {
            const [y, m] = e.target.value.split("-");
            window.location.href = `/dev/revenue?year=${y}&month=${m}`;
          }}
          className="rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
        >
          {monthOptions.map(o => (
            <option key={`${o.year}-${o.month}`} value={`${o.year}-${pad(o.month)}`} className="bg-dark">
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total gross bookings" value={`£${t.total_gross.toFixed(2)}`}      icon={TrendingUp} />
        <StatCard label="Platform commission"  value={`£${t.total_commission.toFixed(2)}`} icon={PoundSterling} />
        <StatCard label="Total bookings"       value={t.total_bookings}                    icon={BarChart2} />
        <StatCard label="Active shops"         value={data?.shops.filter(s => s.booking_count > 0).length ?? 0} icon={ShoppingBag} />
      </div>

      <div className="rounded-xl border border-white/10 bg-dark-100 overflow-x-auto">
        <div className="px-5 py-4 border-b border-white/10">
          <h2 className="font-heading text-base font-semibold text-white">Per-shop breakdown</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              {["Shop","Bookings","Gross value","Commission","Net to shop"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-white/40 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {(data?.shops ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-white/30">No revenue data for this period.</td>
              </tr>
            ) : (
              (data?.shops ?? []).map(r => (
                <tr key={r.shop_id} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3 font-medium text-white">{r.shop_name}</td>
                  <td className="px-4 py-3 text-white/60">{r.booking_count}</td>
                  <td className="px-4 py-3 text-white font-semibold">£{r.gross.toFixed(2)}</td>
                  <td className="px-4 py-3 text-gold font-semibold">£{r.commission.toFixed(2)}</td>
                  <td className="px-4 py-3 text-white/70">£{(r.gross - r.commission).toFixed(2)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
