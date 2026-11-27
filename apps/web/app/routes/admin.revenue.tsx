import { useLoaderData, useNavigate, data as json } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { TrendingUp, PoundSterling, BarChart2, Users, Download } from "lucide-react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { ukParts } from "~/lib/dateFormat";
import { pageShopId } from "~/lib/pageShop";
import { pageTitle } from "~/lib/pageTitle";
import { useShopHref } from "~/lib/useShopHref";
import { formatPence } from "@repo/utils";
import { StatCard } from "~/components/dashboards/StatCard";
import { Button } from "~/components/ui/Button";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import { ErrorScreen } from "~/components/ErrorScreen";
import { revenueCsv } from "~/components/admin/revenueCsv";

export const meta = () => pageTitle("Revenue");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

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

function bookings(n: number): string {
  return n === 1 ? "1 booking" : `${n} bookings`;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user);

  // This month on the London clock; the picker counts back from it, so the
  // server and the browser list the same months.
  const url = new URL(request.url);
  const now = ukParts();
  const current = { year: now.year, month: now.month };
  const askedYear = Number(url.searchParams.get("year"));
  const askedMonth = Number(url.searchParams.get("month"));
  const year = Number.isInteger(askedYear) && askedYear >= 2000 && askedYear <= 2100 ? askedYear : current.year;
  const month = Number.isInteger(askedMonth) && askedMonth >= 1 && askedMonth <= 12 ? askedMonth : current.month;

  let data: RevenueData | null = null;
  let loadError = false;
  if (shopId) {
    try {
      data = await api.get<RevenueData>(
        `/api/shops/${shopId}/revenue?year=${year}&month=${month}`
      );
    } catch {
      loadError = true;
    }
  }

  return json({ data, year, month, shopId, current, loadError });
}

/** Hands the browser a file to save; nothing is sent anywhere. */
function downloadCsv(filename: string, csv: string): void {
  // The byte order mark makes Excel read the file as UTF-8.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

export default function AdminRevenue() {
  const { data, year, month, current, loadError } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const shopHref = useShopHref();

  // Month picker: this month (London) and the 11 before it.
  const monthOptions: { year: number; month: number; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const index = current.year * 12 + (current.month - 1) - i;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    monthOptions.push({ year: y, month: m, label: `${MONTHS[m - 1]} ${y}` });
  }
  const period = `${year}-${pad(month)}`;
  // A month asked for by URL that is older than the picker's twelve still shows as chosen.
  if (!monthOptions.some((o) => `${o.year}-${pad(o.month)}` === period)) {
    monthOptions.push({ year, month, label: `${MONTHS[month - 1]} ${year}` });
  }

  // Chart: max gross for bar scale
  const daily = data?.daily ?? [];
  const maxGross = Math.max(...daily.map(d => d.gross_pence), 1);

  return (
    <div className="space-y-8">
      {/* Header + month selector */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Revenue</h1>
          <p className="mt-0.5 text-sm text-white/60">{MONTHS[month - 1]} {year}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-36">
            <Select
              label="Month"
              hideLabel
              value={period}
              onChange={e => {
                const [y, m] = e.target.value.split("-");
                navigate(shopHref(`/admin/revenue?year=${y}&month=${Number(m)}`));
              }}
            >
              {monthOptions.map(o => (
                <option key={`${o.year}-${o.month}`} value={`${o.year}-${pad(o.month)}`} className="bg-dark">
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          {data && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => downloadCsv(`revenue-${period}.csv`, revenueCsv(data))}
            >
              <Download className="h-4 w-4" aria-hidden /> Download CSV
            </Button>
          )}
        </div>
      </div>

      {loadError && <LoadError what={`revenue for ${MONTHS[month - 1]} ${year}`} />}

      {!data && !loadError && (
        <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-white/60">
          No revenue data for this period.
        </div>
      )}

      {data && (
        <>
          {/* Stats */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Gross bookings" value={formatPence(data.summary.gross_pence)} icon={TrendingUp} />
            <StatCard
              label="Net earnings"
              value={formatPence(data.summary.gross_pence - data.summary.commission_pence)}
              icon={PoundSterling}
            />
            <StatCard label="Platform commission" value={formatPence(data.summary.commission_pence)} icon={BarChart2} />
            <StatCard label="Completed bookings" value={data.summary.booking_count} icon={Users} />
          </div>

          {/* Daily chart */}
          {daily.length > 0 && (
            <section className="min-w-0 rounded-xl border border-white/10 bg-dark-100 p-6">
              <h2 className="mb-1 font-heading text-base font-semibold text-white">Daily revenue in {MONTHS[month - 1]}</h2>
              <p className="mb-8 text-xs text-white/60">Hover, tap or tab to a bar for its day and total.</p>
              <div className="flex h-36 gap-1">
                {daily.map(d => {
                  const pct = (d.gross_pence / maxGross) * 100;
                  const day = Number(d.booking_date.slice(8));
                  const label = `${day} ${MONTHS[month - 1]}: ${formatPence(d.gross_pence)}, ${bookings(d.booking_count)}`;
                  return (
                    <div
                      key={d.booking_date}
                      role="img"
                      aria-label={label}
                      tabIndex={0}
                      className="group relative flex h-full min-w-0 flex-1 flex-col items-center gap-1 rounded outline-none focus-visible:ring-1 focus-visible:ring-gold/60"
                    >
                      {/* Value: hover on pointer devices, tap or keyboard focus elsewhere */}
                      <div className="absolute bottom-full z-10 mb-1 hidden flex-col items-center group-hover:flex group-focus:flex group-active:flex">
                        <div className="whitespace-nowrap rounded border border-white/15 bg-dark-100 px-2 py-1 text-xs text-white">
                          {day} {MONTHS[month - 1]}<br />{formatPence(d.gross_pence)} · {bookings(d.booking_count)}
                        </div>
                      </div>
                      <div className="flex w-full flex-1 items-end">
                        <div
                          className="w-full rounded-t bg-gold/60 transition-colors group-hover:bg-gold group-focus:bg-gold"
                          style={{ height: `${Math.max(pct, 2)}%` }}
                        />
                      </div>
                      {/* Zero width, so a date may run past its own bar; every fifth day is named */}
                      <span
                        aria-hidden
                        className={`flex h-4 w-0 justify-center whitespace-nowrap text-xs leading-none text-white/60 ${
                          day % 5 === 0 ? "" : "invisible"
                        }`}
                      >
                        {day}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Per-staff */}
          {data.by_staff.length > 0 && (
            <section aria-labelledby="revenue-by-staff" className="rounded-xl border border-white/10 bg-dark-100">
              <h2 id="revenue-by-staff" className="border-b border-white/10 px-5 py-4 font-heading text-base font-semibold text-white">
                Revenue by staff
              </h2>
              <ul className="divide-y divide-white/5">
                {data.by_staff.map(r => (
                  <li key={r.staff_id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3">
                    <div className="min-w-[9rem] flex-1">
                      <p className="text-sm font-medium text-white">{r.display_name}</p>
                      <p className="text-xs text-white/60">{bookings(r.booking_count)}</p>
                    </div>
                    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-right text-sm">
                      <div>
                        <dt className="text-xs text-white/60">Gross</dt>
                        <dd className="font-semibold text-gold">{formatPence(r.gross_pence)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-white/60">Commission</dt>
                        <dd className="text-white/70">{formatPence(r.commission_pence)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-white/60">Net</dt>
                        <dd className="text-white">{formatPence(r.gross_pence - r.commission_pence)}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Per-service */}
          {data.by_service.length > 0 && (
            <section aria-labelledby="revenue-by-service" className="rounded-xl border border-white/10 bg-dark-100">
              <h2 id="revenue-by-service" className="border-b border-white/10 px-5 py-4 font-heading text-base font-semibold text-white">
                Revenue by service
              </h2>
              <ul className="divide-y divide-white/5">
                {data.by_service.map(r => (
                  <li key={r.service_id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3">
                    <div className="min-w-[9rem] flex-1">
                      <p className="text-sm font-medium text-white">{r.service_name}</p>
                      <p className="text-xs text-white/60">{bookings(r.booking_count)}</p>
                    </div>
                    <p className="text-sm font-semibold text-gold">{formatPence(r.gross_pence)}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
