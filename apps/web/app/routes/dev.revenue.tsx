import { useLoaderData, useNavigate, useNavigation, data as json } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { formatPence } from "@repo/utils";
import { ErrorScreen } from "~/components/ErrorScreen";
import { StatCard } from "~/components/dashboards/StatCard";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import { pageTitle } from "~/lib/pageTitle";
import { MONTHS_OFFERED, monthFromParams } from "~/components/dev-shops/revenueMonth";
import { TrendingUp, BarChart2, ShoppingBag, PoundSterling } from "lucide-react";

export const meta = () => pageTitle("Revenue");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/dev" homeLabel="Back to overview" />;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function pad(n: number) {
  return String(n).padStart(2, "0");
}

interface ShopRow {
  shop_id: string;
  shop_name: string;
  booking_count: number;
  gross_pence: number;
  commission_pence: number;
}
interface Totals {
  total_bookings: number;
  total_gross_pence: number;
  total_commission_pence: number;
}
interface RevenueData {
  year: number;
  month: number;
  totals: Totals;
  shops: ShopRow[];
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "developer", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  const now = new Date();
  const { year, month, adjusted } = monthFromParams(new URL(request.url).searchParams, now);

  // The chosen month, and with it every month of the same year so far, for the
  // year total. The API answers one month at a time; they all go out together.
  const lastMonthOfYear = year === now.getUTCFullYear() ? now.getUTCMonth() + 1 : 12;
  const months = Array.from({ length: lastMonthOfYear }, (_, i) => i + 1);
  const answers = await Promise.allSettled(
    months.map((m) => api.get<RevenueData>(`/api/dev/revenue?year=${year}&month=${m}`)),
  );

  const chosen = answers[month - 1];
  const data = chosen?.status === "fulfilled" && chosen.value && Array.isArray(chosen.value.shops) ? chosen.value : null;

  // A year total with a month missing would be a wrong number, so it is
  // offered only when every month was read.
  let yearTotals: Totals | null = { total_bookings: 0, total_gross_pence: 0, total_commission_pence: 0 };
  for (const answer of answers) {
    if (answer.status !== "fulfilled" || !answer.value?.totals) {
      yearTotals = null;
      break;
    }
    yearTotals.total_bookings += answer.value.totals.total_bookings;
    yearTotals.total_gross_pence += answer.value.totals.total_gross_pence;
    yearTotals.total_commission_pence += answer.value.totals.total_commission_pence;
  }

  return json({
    data,
    year,
    month,
    adjusted,
    yearTotals,
    yearComplete: lastMonthOfYear === 12,
    nowYear: now.getUTCFullYear(),
    nowMonth: now.getUTCMonth() + 1,
  });
}

const GRID = "md:grid md:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] md:gap-4";

function Figure({ label, children, strong }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 md:block md:text-right">
      <dt className="text-sm text-white/60 md:sr-only">{label}</dt>
      <dd className={strong ? "font-semibold text-white" : "text-white/80"}>{children}</dd>
    </div>
  );
}

function TotalsRow({ label, totals }: { label: string; totals: Totals }) {
  return (
    <div className={`px-4 py-4 sm:px-5 ${GRID}`}>
      <p className="font-semibold text-white">{label}</p>
      <dl className="mt-2 space-y-1 md:contents md:space-y-0">
        <Figure label="Bookings" strong>
          {totals.total_bookings}
        </Figure>
        <Figure label="Gross value" strong>
          {formatPence(totals.total_gross_pence)}
        </Figure>
        <Figure label="Commission" strong>
          {formatPence(totals.total_commission_pence)}
        </Figure>
        <Figure label="Net to shops" strong>
          {formatPence(totals.total_gross_pence - totals.total_commission_pence)}
        </Figure>
      </dl>
    </div>
  );
}

export default function DevRevenue() {
  const { data, year, month, adjusted, yearTotals, yearComplete, nowYear, nowMonth } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const changing = navigation.state === "loading" && navigation.location?.pathname === "/dev/revenue";

  // Built from the loader's "now", so the server and the browser offer the same months.
  const monthOptions: { value: string; label: string }[] = [];
  for (let i = 0; i < MONTHS_OFFERED; i++) {
    const d = new Date(Date.UTC(nowYear, nowMonth - 1 - i, 1));
    monthOptions.push({
      value: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`,
      label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
    });
  }
  const period = `${MONTHS[month - 1]} ${year}`;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Platform Revenue</h1>
          <p className="mt-0.5 text-sm text-white/60" role="status">
            {changing ? "Loading…" : period}
          </p>
        </div>
        <div className="w-full sm:w-52">
          <Select
            label="Month"
            value={`${year}-${pad(month)}`}
            disabled={changing}
            onChange={(e) => {
              const [y, m] = e.target.value.split("-");
              navigate(`/dev/revenue?year=${y}&month=${Number(m)}`);
            }}
          >
            {monthOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {adjusted && (
        <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          The month in the address is not one this page can show, so this is {period}. Pick a month from the list.
        </p>
      )}

      {!data ? (
        <LoadError what={`the revenue for ${period}`} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Gross booking value" value={formatPence(data.totals.total_gross_pence)} icon={TrendingUp} />
            <StatCard
              label="Platform commission"
              value={formatPence(data.totals.total_commission_pence)}
              icon={PoundSterling}
            />
            <StatCard label="Bookings" value={data.totals.total_bookings} icon={BarChart2} />
            <StatCard
              label="Shops with bookings"
              value={data.shops.filter((s) => s.booking_count > 0).length}
              icon={ShoppingBag}
            />
          </div>

          <section aria-labelledby="revenue-breakdown-heading" className="rounded-xl border border-white/10 bg-dark-100">
            <div className="border-b border-white/10 px-4 py-4 sm:px-5">
              <h2 id="revenue-breakdown-heading" className="font-heading text-base font-semibold text-white">
                Per-shop breakdown, {period}
              </h2>
            </div>
            {data.shops.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-white/60">No bookings were recorded in {period}.</p>
            ) : (
              <>
                <div
                  aria-hidden
                  className={`hidden border-b border-white/10 px-5 py-3 text-xs font-semibold uppercase tracking-wider text-white/60 ${GRID}`}
                >
                  <span>Shop</span>
                  <span className="text-right">Bookings</span>
                  <span className="text-right">Gross value</span>
                  <span className="text-right">Commission</span>
                  <span className="text-right">Net to shop</span>
                </div>
                <ul className="divide-y divide-white/5">
                  {data.shops.map((r) => (
                    <li key={r.shop_id} className={`px-4 py-4 hover:bg-white/[0.02] sm:px-5 ${GRID}`}>
                      <p className="font-medium text-white">{r.shop_name}</p>
                      <dl className="mt-2 space-y-1 md:contents md:space-y-0">
                        <Figure label="Bookings">{r.booking_count}</Figure>
                        <Figure label="Gross value" strong>
                          {formatPence(r.gross_pence)}
                        </Figure>
                        <Figure label="Commission" strong>
                          {formatPence(r.commission_pence)}
                        </Figure>
                        <Figure label="Net to shop">{formatPence(r.gross_pence - r.commission_pence)}</Figure>
                      </dl>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="divide-y divide-white/5 border-t border-white/10">
              <TotalsRow label={`${period} total`} totals={data.totals} />
              {yearTotals ? (
                <TotalsRow label={yearComplete ? `${year} total` : `${year} so far`} totals={yearTotals} />
              ) : (
                <p className="px-4 py-4 text-sm text-white/70 sm:px-5">
                  The {year} total is not shown: one or more of its months could not be loaded. Reload to try again.
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
