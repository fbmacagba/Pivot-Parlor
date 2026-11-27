import { Link, useFetcher, useLoaderData, useSearchParams, data as json } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { readJsonObject } from "@repo/utils";
import { useRef, useState } from "react";
import { Check } from "lucide-react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { ErrorScreen } from "~/components/ErrorScreen";
import { BookingRow } from "~/components/staff/BookingRow";
import { LIST_CAP, LIST_PAGE, listLimit } from "~/components/staff/today";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { Textarea } from "~/components/ui/Textarea";
import { formatDay, ukToday } from "~/lib/dateFormat";
import { DEVELOPER_STAFF_READ_ONLY, pageStaffId, staffMePath } from "~/lib/pageShop";
import { pageTitle } from "~/lib/pageTitle";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";
import { useFetcherResult } from "~/lib/useFetcherResult";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("My bookings");

interface Booking {
  id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  customer_name: string;
  service_name: string;
  duration_min: number;
}

interface TimeOff {
  id: string;
  from_date: string;
  to_date: string;
  reason: string | null;
  status: "pending" | "approved" | "denied";
  created_at: string;
}

interface ScheduleRow { day_of_week: number; start_time: string; end_time: string; is_active: number }

const DAY_LABELS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

const TABS = [
  { key: "bookings", label: "My bookings" },
  { key: "availability", label: "Availability" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const FILTERS = [
  { key: "today", label: "Today", empty: "No bookings today." },
  { key: "upcoming", label: "Upcoming", empty: "No upcoming bookings." },
  { key: "past", label: "Past", empty: "No past bookings." },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

/** A calendar day ("2026-11-12": booking_date, from_date, to_date) as "12 Nov 2026". */
function formatDate(day: string) {
  return formatDay(day, { day: "numeric", month: "short", year: "numeric" });
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "staff", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const url = new URL(request.url);
  const filter: FilterKey = FILTERS.find((f) => f.key === url.searchParams.get("filter"))?.key ?? "upcoming";
  const tab: TabKey = url.searchParams.get("tab") === "availability" ? "availability" : "bookings";
  const limit = listLimit(url.searchParams.get("limit"));
  // A developer views the staff member they chose (staff.tsx), read-only.
  const readOnly = user.role === "developer";
  const staffId = pageStaffId(request, user);
  const needsStaff = readOnly && !staffId;

  let bookings: Booking[] = [];
  let schedule: ScheduleRow[] = [];
  let timeOff: TimeOff[] = [];
  // One flag per section: a failed load must never read as "no bookings",
  // a week of days off, or no requests.
  let bookingsError = false;
  let scheduleError = false;
  let timeOffError = false;

  if (!needsStaff) {
    const path = (p: string) => staffMePath(p, staffId);
    const list = <T,>(p: string) =>
      api.get<T[]>(path(p)).then((rows) => {
        if (!Array.isArray(rows)) throw new Error("Not a list");
        return rows;
      });
    // Only what the open tab shows is fetched, and its calls run together.
    if (tab === "bookings") {
      await list<Booking>(`/api/staff/me/bookings?filter=${filter}&limit=${limit}`).then(
        (rows) => { bookings = rows; },
        () => { bookingsError = true; },
      );
    } else {
      await Promise.all([
        list<ScheduleRow>("/api/staff/me/schedule").then(
          (rows) => { schedule = rows; },
          () => { scheduleError = true; },
        ),
        list<TimeOff>("/api/staff/me/time-off").then(
          (rows) => { timeOff = rows; },
          () => { timeOffError = true; },
        ),
      ]);
    }
  }

  return json({
    bookings, schedule, timeOff, bookingsError, scheduleError, timeOffError,
    filter, tab, limit, readOnly, needsStaff, today: ukToday(),
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "staff", env.API_URL);
  if (user.role === "developer") {
    return json({ ok: false, error: DEVELOPER_STAFF_READ_ONLY }, { status: 403 });
  }
  const body = await readJsonObject<{ from_date?: string; to_date?: string; reason?: string }>(request);
  // "Invalid JSON" is this answer's contract (signedInActionsRejectBadJson.test.ts);
  // the page never sends such a body, so nobody is shown it.
  if (!body) return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  try {
    await api.post("/api/staff/me/time-off", body);
    return json({ ok: true });
  } catch (e) {
    return json(
      { ok: false, error: e instanceof Error && e.message ? e.message : "Your request was not sent. Check your connection and try again." },
      { status: 400 },
    );
  }
}

const TAB_ID = (key: string) => `pp-staff-tab-${key}`;
const PANEL_ID = (key: string) => `pp-staff-panel-${key}`;

export default function StaffBookingsAvailability() {
  const {
    bookings, schedule, timeOff, bookingsError, scheduleError, timeOffError,
    filter, tab: activeTab, limit, readOnly, needsStaff, today,
  } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [result, setResult] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate]     = useState("");
  const [reason, setReason]     = useState("");
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useFetcherResult(fetcher, (data) => {
    if (data.ok) {
      setResult({ type: "success", text: "Time off request sent. Your manager will approve or decline it." });
      setFromDate(""); setToDate(""); setReason("");
    } else {
      setResult({ type: "error", text: data.error ?? "Your request was not sent. Check your connection and try again." });
    }
  });

  const openTab = (key: TabKey) =>
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      n.set("tab", key);
      n.delete("limit");
      return n;
    });

  /** The same list, longer, with every other search param kept (a developer's shop and staff member). */
  const moreHref = () => {
    const n = new URLSearchParams(params);
    n.set("limit", String(Math.min(LIST_CAP, limit + LIST_PAGE)));
    return `?${n}`;
  };

  const emptyText = FILTERS.find((f) => f.key === filter)?.empty ?? "No bookings.";
  // A full page may have more behind it; the API has no count to say for sure.
  const full = bookings.length >= limit;
  const backwards = fromDate !== "" && toDate !== "" && toDate < fromDate;

  return (
    <div className="space-y-6">
      <h1 className="font-heading text-2xl font-bold text-white">
        {activeTab === "availability" ? "Availability" : "My bookings"}
      </h1>

      {/* Page tabs: the selected one is underlined and heavier, not only gold */}
      <div role="tablist" aria-label="Bookings and availability" className="flex gap-1 border-b border-white/10">
        {TABS.map((t, i) => {
          const selected = activeTab === t.key;
          return (
            <button
              key={t.key}
              ref={(el) => { tabRefs.current[t.key] = el; }}
              type="button"
              role="tab"
              id={TAB_ID(t.key)}
              aria-selected={selected}
              aria-controls={PANEL_ID(t.key)}
              tabIndex={selected ? 0 : -1}
              onClick={() => openTab(t.key)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                const other = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
                openTab(other.key);
                tabRefs.current[other.key]?.focus();
              }}
              className={`tap-target -mb-px border-b-2 px-4 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold ${
                selected
                  ? "border-gold font-semibold text-gold"
                  : "border-transparent font-medium text-white/60 hover:text-white"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ── BOOKINGS TAB ── */}
      {activeTab === "bookings" && (
        <div role="tabpanel" id={PANEL_ID("bookings")} aria-labelledby={TAB_ID("bookings")} className="space-y-4">
          {/* Filters: the pressed one is filled and ticked */}
          <div role="group" aria-label="Which bookings to show" className="flex flex-wrap gap-2">
            {FILTERS.map((f) => {
              const pressed = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() =>
                    setParams((prev) => {
                      const n = new URLSearchParams(prev);
                      n.set("filter", f.key);
                      n.set("tab", "bookings");
                      n.delete("limit");
                      return n;
                    })
                  }
                  aria-pressed={pressed}
                  className={`tap-target inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                    pressed
                      ? "border-gold/40 bg-gold/20 font-semibold text-gold"
                      : "border-white/10 font-medium text-white/60 hover:text-white"
                  }`}
                >
                  {pressed && <Check className="h-3.5 w-3.5" aria-hidden />}
                  {f.label}
                </button>
              );
            })}
          </div>

          {needsStaff ? (
            <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-white/60">
              Choose a staff member above to see their bookings.
            </div>
          ) : bookingsError ? (
            <LoadError what="your bookings" />
          ) : bookings.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-white/60">
              {emptyText}
            </div>
          ) : (
            <>
              <ul className="space-y-2">
                {bookings.map((b) => (
                  <BookingRow key={b.id} booking={b} today={today} readOnly={readOnly} showDate />
                ))}
              </ul>
              {full && limit < LIST_CAP && (
                <div className="text-center">
                  <Button asChild variant="secondary">
                    <Link to={moreHref()} preventScrollReset replace>
                      Load more bookings
                    </Link>
                  </Button>
                </div>
              )}
              {full && limit >= LIST_CAP && (
                <p role="status" className="text-center text-sm text-white/60">
                  Showing the first {LIST_CAP} bookings, which is as many as this list holds. Ask the shop owner
                  for anything further back or further ahead.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* ── AVAILABILITY TAB ── */}
      {activeTab === "availability" && (
        <div
          role="tabpanel"
          id={PANEL_ID("availability")}
          aria-labelledby={TAB_ID("availability")}
          className="max-w-2xl space-y-6"
        >
          {needsStaff ? (
            <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-white/60">
              Choose a staff member above to see their availability.
            </div>
          ) : (
          <>
          {/* Weekly schedule (read-only) */}
          <div className="rounded-xl border border-white/10 bg-dark-100 p-5">
            <h2 className="font-heading text-base font-semibold text-white mb-1">Weekly schedule</h2>
            <p className="text-xs text-white/60 mb-4">Set by your manager. Contact them to make changes.</p>
            {scheduleError ? (
              <LoadError what="your weekly schedule" />
            ) : (
              <dl className="space-y-2">
                {DAY_LABELS.map((label, d) => {
                  const row = schedule.find(s => s.day_of_week === d);
                  const isOn = row?.is_active === 1;
                  return (
                    <div key={d} className="flex items-center gap-4 text-sm">
                      <dt className="w-24 font-medium text-white/80">{label}</dt>
                      <dd className={isOn ? "text-white" : "text-white/60"}>
                        {isOn && row ? `${row.start_time} to ${row.end_time}` : "Off"}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </div>

          {/* Time off request form: the staff member's own; a developer only views. */}
          {readOnly ? (
            <p className="rounded-xl border border-white/10 bg-dark-100 p-5 text-sm text-white/60">
              Time off is requested by the staff member from their own screens.
            </p>
          ) : (
          <div className="rounded-xl border border-white/10 bg-dark-100 p-5">
            <h2 className="font-heading text-base font-semibold text-white mb-4">Request time off</h2>
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Input label="From date" name="from" type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
                <Input
                  label="To date"
                  name="to"
                  type="date"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={e => setToDate(e.target.value)}
                  error={backwards ? "The last day must be on or after the first." : undefined}
                />
              </div>
              <Textarea
                label="Reason (optional)"
                name="reason"
                rows={3}
                value={reason}
                onChange={e => setReason(e.target.value)}
              />
              <Button
                type="button"
                disabled={!fromDate || !toDate || backwards || fetcher.state !== "idle"}
                onClick={() => {
                  setResult(null);
                  void fetcher.submit(
                    { from_date: fromDate, to_date: toDate, ...(reason.trim() ? { reason: reason.trim() } : {}) },
                    { method: "POST", encType: "application/json" }
                  );
                }}
              >
                {fetcher.state !== "idle" ? "Submitting…" : "Submit request"}
              </Button>
              {result?.type === "success" && (
                <p role="status" className="flex items-center gap-1.5 text-sm text-emerald-300">
                  <Check className="h-4 w-4 shrink-0" aria-hidden /> {result.text}
                </p>
              )}
              {result?.type === "error" && (
                <p role="alert" className="text-sm text-red-300">{result.text}</p>
              )}
            </div>
          </div>
          )}

          {/* The requests made so far */}
          {timeOffError ? (
            <LoadError what="your time off requests" />
          ) : timeOff.length > 0 && (
            <div className="rounded-xl border border-white/10 bg-dark-100">
              <div className="px-5 py-4 border-b border-white/10">
                <h2 className="font-heading text-base font-semibold text-white">My requests</h2>
              </div>
              <ul className="divide-y divide-white/5">
                {timeOff.map(r => (
                  <li key={r.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3">
                    <div className="min-w-[12rem] flex-1">
                      <p className="text-sm font-medium text-white">
                        {r.from_date === r.to_date
                          ? formatDate(r.from_date)
                          : `${formatDate(r.from_date)} to ${formatDate(r.to_date)}`}
                      </p>
                      <p className="mt-0.5 break-words text-sm text-white/60">{r.reason?.trim() || "No reason given"}</p>
                    </div>
                    <StatusBadge status={r.status} className="ml-auto shrink-0" />
                  </li>
                ))}
              </ul>
            </div>
          )}
          </>
          )}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/staff" homeLabel="Back to today" />;
}
