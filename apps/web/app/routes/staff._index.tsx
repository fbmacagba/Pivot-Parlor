import { useEffect, useState } from "react";
import { Link, useLoaderData, useRevalidator, data as json } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { ArrowRight, CheckCircle, Clock } from "lucide-react";
import { formatPence } from "@repo/utils";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { ErrorScreen } from "~/components/ErrorScreen";
import { ShareShopCard } from "~/components/dashboards/ShareShopCard";
import { BookingActions } from "~/components/staff/BookingActions";
import { BookingRow, bookingClock } from "~/components/staff/BookingRow";
import { countdownLabel, pickNextBooking, type NextKind } from "~/components/staff/today";
import { Badge } from "~/components/ui/Badge";
import { LoadError } from "~/components/ui/LoadError";
import { formatDate, ukParts, ukToday } from "~/lib/dateFormat";
import { pageShopId, pageStaffId, staffMePath } from "~/lib/pageShop";
import { pageTitle } from "~/lib/pageTitle";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";
import { usePolling } from "~/lib/usePolling";
import { useShopHref } from "~/lib/useShopHref";

export const meta = () => pageTitle("Today");

// Start and Complete post to the booking's own page (BookingActions). When
// one is refused, the day shown here may be out of date: reload it.
export const shouldRevalidate = revalidateAfterFailedSubmission;

interface TodayBooking {
  id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  customer_name: string;
  service_name: string;
  duration_min: number;
  amount_pence: number;
  notes?: string | null;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "staff", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  // A developer views the staff member they chose (staff.tsx); until they
  // choose one there is nobody's day to show.
  const shopId = pageShopId(request, user);
  const staffId = pageStaffId(request, user);
  const readOnly = user.role === "developer";
  const needsStaff = readOnly && !staffId;

  const [today, shop] = await Promise.allSettled([
    needsStaff
      ? Promise.resolve<TodayBooking[]>([])
      : api.get<TodayBooking[]>(staffMePath("/api/staff/me/today", staffId)),
    // The share card is an extra: without the shop it is simply not shown.
    shopId ? api.get<{ slug: string; name: string }>(`/api/shops/${shopId}`) : Promise.resolve(null),
  ]);

  // A failed load must never read as "no appointments today".
  const loadError = today.status === "rejected" || !Array.isArray(today.value);
  const todayBookings = today.status === "fulfilled" && Array.isArray(today.value) ? today.value : [];

  // "Now" is read once here and rendered from, so the server's page and the
  // browser's first render agree; the browser starts its own clock after that.
  const now = Date.now();
  const { hour } = ukParts(now);
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  // Public shop-site URL for the share card. Built from the request origin so
  // staging previews link to themselves rather than production.
  const shopRow = shop.status === "fulfilled" ? shop.value : null;
  const shopShare = shopRow?.slug
    ? { url: `${new URL(request.url).origin}/${shopRow.slug}`, name: shopRow.name }
    : null;

  return json({ todayBookings, loadError, greeting, shopShare, needsStaff, readOnly, now, today: ukToday(new Date(now)) });
}

const NEXT_HEADING: Record<NextKind, string> = {
  in_progress: "In progress now",
  upcoming: "Next appointment",
  due: "Next appointment",
  overdue: "Still open from earlier",
};

export default function StaffToday() {
  const { todayBookings, loadError, greeting, shopShare, needsStaff, readOnly, now: loadedAt, today } =
    useLoaderData<typeof loader>();
  const shopHref = useShopHref();
  const revalidator = useRevalidator();

  // The clock: the loader's reading until the page is live in the browser,
  // then the browser's own, ticking. A fresh load brings a fresh reading.
  const [now, setNow] = useState(loadedAt);
  useEffect(() => {
    setNow(Math.max(loadedAt, Date.now()));
  }, [loadedAt]);
  usePolling(() => setNow(Date.now()), { intervalMs: 20_000 });
  // The day itself: a booking made, moved or cancelled elsewhere shows up
  // within a minute, while this screen is the one being looked at.
  usePolling(
    () => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    },
    { intervalMs: 60_000, enabled: !needsStaff },
  );

  const open = todayBookings.filter((b) => b.status !== "completed" && b.status !== "cancelled" && b.status !== "no_show");
  const completed = todayBookings.filter((b) => b.status === "completed");
  const next = pickNextBooking(todayBookings, now);
  const earnedPence = completed.reduce((sum, b) => sum + (Number(b.amount_pence) || 0), 0);

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">{greeting}</h1>
          <p className="mt-0.5 text-sm text-white/60">
            {formatDate(now, { weekday: "long", day: "numeric", month: "long" })}
          </p>
        </div>
        <Link
          to={shopHref("/staff/bookings?filter=upcoming")}
          className="tap-target flex items-center gap-1.5 text-sm text-gold hover:text-gold/80"
        >
          Tomorrow and later <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      {needsStaff ? (
        <div className="rounded-xl border border-dashed border-white/10 p-8 text-center">
          <p className="text-sm text-white/60">Choose a staff member above to see their day.</p>
        </div>
      ) : loadError ? (
        <LoadError what="today's appointments" />
      ) : (
        <>
          {/* Next appointment card */}
          {next ? (
            <section className="rounded-xl border border-gold/25 bg-gold/5 p-5" aria-labelledby="pp-staff-next">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 id="pp-staff-next" className="text-xs font-semibold uppercase tracking-wider text-gold">
                  {NEXT_HEADING[next.kind]}
                </h2>
                {next.kind === "upcoming" && next.startMs !== null && (
                  <p className="flex items-center gap-1.5 text-sm text-white/70">
                    <Clock className="h-3.5 w-3.5" aria-hidden />
                    {countdownLabel(next.startMs, now)}
                  </p>
                )}
                {next.kind === "due" && <Badge variant="gold">Due now</Badge>}
                {next.kind === "overdue" && <Badge variant="warning">Overdue</Badge>}
              </div>
              <Link
                to={shopHref(`/staff/bookings/${next.booking.id}`)}
                aria-label={`${next.booking.customer_name}, ${next.booking.service_name}, ${bookingClock(next.booking.start_time)}. Open booking`}
                className="tap-target -mx-2 flex items-start gap-4 rounded-lg px-2 py-1 transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              >
                <span className="flex min-w-[72px] flex-col items-center justify-center rounded-lg bg-gold/10 px-4 py-3">
                  <span className="text-xl font-bold text-gold">{bookingClock(next.booking.start_time)}</span>
                  <span className="mt-0.5 text-xs text-white/70">{next.booking.duration_min}m</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-base font-semibold text-white">
                    {next.booking.customer_name}
                  </span>
                  <span className="mt-0.5 block text-sm text-white/70">{next.booking.service_name}</span>
                  {next.booking.notes?.trim() && (
                    <span className="mt-1 block break-words text-sm italic text-white/70">{next.booking.notes}</span>
                  )}
                </span>
              </Link>
              {next.kind === "overdue" && (
                <p className="mt-3 text-sm text-white/70">
                  Its time has passed and it was never marked. Complete it if it happened, or leave it for the shop
                  owner to sort out.
                </p>
              )}
              {!readOnly && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <BookingActions booking={next.booking} today={today} show="all" />
                </div>
              )}
            </section>
          ) : (
            <div className="rounded-xl border border-dashed border-white/10 p-8 text-center">
              <p className="text-sm text-white/60">
                {todayBookings.length === 0 ? "No appointments today." : "No more appointments today."}
              </p>
            </div>
          )}

          {/* Today's schedule */}
          {open.length > 0 && (
            <section aria-labelledby="pp-staff-schedule">
              <h2 id="pp-staff-schedule" className="mb-3 font-heading text-base font-semibold text-white">
                Today&apos;s schedule
                <span className="ml-2 text-xs font-normal text-white/60">
                  {open.length} to go · {completed.length} done
                </span>
              </h2>
              <ul className="space-y-2">
                {open.map((b) => (
                  <BookingRow
                    key={b.id}
                    booking={b}
                    today={today}
                    readOnly={readOnly}
                    highlight={b.id === next?.booking.id}
                  />
                ))}
              </ul>
            </section>
          )}

          {/* Done today: the count, what it was worth, and the rows on demand */}
          {completed.length > 0 && (
            <details>
              <summary className="tap-target flex cursor-pointer list-none items-center gap-2 rounded-lg py-1 text-sm text-white/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">
                <CheckCircle className="h-4 w-4" aria-hidden />
                {completed.length} done today, worth {formatPence(earnedPence)} in services
              </summary>
              <ul className="mt-2 space-y-2">
                {completed.map((b) => (
                  <BookingRow key={b.id} booking={b} today={today} readOnly={readOnly} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {/* Share your shop */}
      {shopShare && <ShareShopCard shopUrl={shopShare.url} shopName={shopShare.name} />}
    </div>
  );
}

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/staff" homeLabel="Back to today" />;
}
