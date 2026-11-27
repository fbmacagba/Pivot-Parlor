import { useState, useMemo } from "react";
import type { Booking } from "~/routes/admin.bookings";
import { formatPence } from "@repo/utils";
import { Button } from "~/components/ui/Button";
import { statusLabel } from "~/components/ui/StatusBadge";
import { clockOf, formatDay, ukParts, ukToday } from "~/lib/dateFormat";
import { monthIsLoaded, monthRange } from "./bookingsWindow";

/** The status dot colours (DESIGN.md, Status mapping): the same tokens as the pills, never blue. */
const STATUS_DOT: Record<string, string> = {
  pending: "bg-amber-400",
  confirmed: "bg-emerald-400",
  in_progress: "bg-gold",
  completed: "bg-white/40",
  cancelled: "bg-red-400",
  no_show: "bg-white/20",
};
const LEGEND = ["pending", "confirmed", "completed", "cancelled", "no_show"] as const;

function dotClass(status: string): string {
  return STATUS_DOT[status] ?? "bg-white/40";
}

/** "9:05am": a walk-in's own clock time, or an instant on the London clock
 *  (app/lib/dateFormat.ts). Anything else is shown as it is. */
function formatTime(start: string) {
  const clock = clockOf(start);
  if (!clock) return start;
  const { hour: h, minute: m } = clock;
  const p = h >= 12 ? "pm" : "am";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${p}`;
}

/** "3 bookings: 2 confirmed, 1 pending", the words behind a day's dots. */
export function daySummary(dayBookings: Array<{ status: string }>): string {
  const n = dayBookings.length;
  if (n === 0) return "No bookings";
  const counts = new Map<string, number>();
  for (const b of dayBookings) counts.set(b.status, (counts.get(b.status) ?? 0) + 1);
  const parts = Array.from(counts.entries()).map(([status, count]) => `${count} ${statusLabel(status).toLowerCase()}`);
  return `${n} booking${n !== 1 ? "s" : ""}: ${parts.join(", ")}`;
}

interface BookingsCalendarProps {
  bookings: Booking[];
  onSelectBooking: (b: Booking) => void;
  /** The days the page has loaded bookings for (inclusive). Without it, every month counts as loaded. */
  loadedFrom?: string;
  loadedTo?: string;
  /** Asks the page to load a month that is outside the loaded days. */
  onLoadMonth?: (from: string, to: string) => void;
  /** True while the page is fetching bookings. */
  loading?: boolean;
}

export function BookingsCalendar({
  bookings,
  onSelectBooking,
  loadedFrom,
  loadedTo,
  onLoadMonth,
  loading = false,
}: BookingsCalendarProps) {
  // Today in London, the same on the server and in the browser.
  const todayStr = ukToday();
  const { year: todayYear, month: todayMonth } = ukParts();

  const [viewMonth, setViewMonth] = useState(todayMonth - 1);
  const [viewYear, setViewYear] = useState(todayYear);
  const [selectedDate, setSelectedDate] = useState<string | null>(todayStr);

  const bookingsByDate = useMemo(() => {
    const map: Record<string, Booking[]> = {};
    for (const b of bookings) {
      if (!map[b.booking_date]) map[b.booking_date] = [];
      map[b.booking_date].push(b);
    }
    return map;
  }, [bookings]);

  const { calendarDays, monthLabel, monthName } = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const lastDay = new Date(viewYear, viewMonth + 1, 0);
    const startDow = (firstDay.getDay() + 6) % 7;
    const first = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-01`;

    const days: Array<{ date: string | null; dayNum: number | null }> = [];
    for (let i = 0; i < startDow; i++) days.push({ date: null, dayNum: null });
    for (let d = 1; d <= lastDay.getDate(); d++) {
      const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      days.push({ date: dateStr, dayNum: d });
    }
    return {
      calendarDays: days,
      monthLabel: formatDay(first, { month: "long", year: "numeric" }),
      monthName: formatDay(first, { month: "long" }),
    };
  }, [viewMonth, viewYear]);

  const hasWindow = Boolean(loadedFrom && loadedTo);
  const isLoaded = (year: number, month: number) =>
    !hasWindow || monthIsLoaded(year, month, { from: loadedFrom!, to: loadedTo! });
  const viewLoaded = isLoaded(viewYear, viewMonth);
  const isDayLoaded = (date: string) => !hasWindow || (date >= loadedFrom! && date <= loadedTo!);

  const selectedBookings = selectedDate
    ? (bookingsByDate[selectedDate] ?? []).slice().sort((a, b) => a.start_time.localeCompare(b.start_time))
    : [];

  /** Shows a month, and asks the page for its bookings when they are not loaded. */
  function goTo(year: number, month: number, select: string | null) {
    setViewYear(year);
    setViewMonth(month);
    setSelectedDate(select);
    if (!isLoaded(year, month) && onLoadMonth) {
      const range = monthRange(year, month);
      onLoadMonth(range.from, range.to);
    }
  }

  const prevMonth = () => (viewMonth === 0 ? goTo(viewYear - 1, 11, null) : goTo(viewYear, viewMonth - 1, null));
  const nextMonth = () => (viewMonth === 11 ? goTo(viewYear + 1, 0, null) : goTo(viewYear, viewMonth + 1, null));

  return (
    <div className="flex flex-col gap-6 lg:flex-row">

      {/* Calendar grid */}
      <div className="min-w-0 flex-1">

        {/* Nav */}
        <div className="mb-4 flex items-center justify-between">
          <Button type="button" variant="ghost" size="icon" onClick={prevMonth} aria-label="Previous month" className="text-white/70">
            <svg aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-white" aria-live="polite">{monthLabel}</h2>
            <Button type="button" variant="secondary" size="sm" onClick={() => goTo(todayYear, todayMonth - 1, todayStr)}>
              Today
            </Button>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={nextMonth} aria-label="Next month" className="text-white/70">
            <svg aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Button>
        </div>

        {/* A month the page has not loaded must never read as an empty month. */}
        {loading ? (
          <p role="status" className="mb-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/70">
            Loading bookings for {monthLabel}…
          </p>
        ) : !viewLoaded ? (
          <div role="status" className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <p className="min-w-[12rem] flex-1 text-sm text-amber-100">
              Only bookings from {formatDay(loadedFrom!, { day: "numeric", month: "short", year: "numeric" })} to{" "}
              {formatDay(loadedTo!, { day: "numeric", month: "short", year: "numeric" })} are loaded, so part of {monthName} may
              look empty when it is not.
            </p>
            {onLoadMonth && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  const range = monthRange(viewYear, viewMonth);
                  onLoadMonth(range.from, range.to);
                }}
              >
                Load all of {monthName}
              </Button>
            )}
          </div>
        ) : null}

        {/* Day headers */}
        <div className="mb-1 grid grid-cols-7" aria-hidden>
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="py-2 text-center text-xs font-semibold text-white/60">{d}</div>
          ))}
        </div>

        {/* Cells */}
        <div className="grid grid-cols-7 gap-1">
          {calendarDays.map((cell, idx) => {
            if (!cell.date) return <div key={`e-${idx}`} className="h-[72px]" />;

            const dayBookings = bookingsByDate[cell.date] ?? [];
            const isToday = cell.date === todayStr;
            const isSelected = cell.date === selectedDate;
            const hasBookings = dayBookings.length > 0;
            const dayLoaded = isDayLoaded(cell.date);
            const statuses = Array.from(new Set(dayBookings.map((b) => b.status)));
            const dayName = formatDay(cell.date, { weekday: "long", day: "numeric", month: "long" });

            return (
              <button
                key={cell.date}
                type="button"
                onClick={() => setSelectedDate(isSelected ? null : cell.date)}
                aria-pressed={isSelected}
                className={[
                  "flex h-[72px] flex-col items-start rounded-xl border p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold",
                  isSelected
                    ? "border-gold bg-gold/20 ring-1 ring-gold"
                    : isToday
                    ? "border-white/20 bg-white/10 hover:border-white/30"
                    : hasBookings
                    ? "border-white/10 bg-dark-100 hover:border-white/20"
                    : "border-transparent bg-transparent hover:bg-white/5",
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "flex h-6 w-6 items-center justify-center rounded-full text-sm font-semibold",
                    isSelected ? "font-bold text-gold" : isToday ? "bg-gold font-bold text-dark" : "text-white/70",
                  ].join(" ")}
                >
                  {cell.dayNum}
                </span>
                {/* The words behind the number and the dots. */}
                <span className="sr-only">
                  {dayName}
                  {isToday ? ", today" : ""}. {dayLoaded ? daySummary(dayBookings) : "Bookings not loaded"}.
                </span>

                {hasBookings && (
                  <div className="mt-auto w-full" aria-hidden>
                    <span className="text-xs text-white/70">{dayBookings.length}</span>
                    <div className="mt-0.5 flex flex-wrap gap-0.5">
                      {statuses.map((status) => (
                        <span key={status} className={`h-2 w-2 rounded-full ${dotClass(status)}`} />
                      ))}
                    </div>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="mt-4 flex flex-wrap gap-4 text-xs text-white/60">
          <span>The number is how many bookings that day.</span>
          {LEGEND.map((status) => (
            <div key={status} className="flex items-center gap-1.5">
              <span aria-hidden className={`h-2 w-2 rounded-full ${dotClass(status)}`} />
              {statusLabel(status)}
            </div>
          ))}
        </div>
      </div>

      {/* Day panel */}
      <div className="shrink-0 lg:w-72">
        <div className="overflow-hidden rounded-xl border border-white/10 bg-dark-100 lg:sticky lg:top-6">
          <div className="border-b border-white/10 bg-white/5 px-5 py-4">
            <h3 className="text-sm font-semibold text-white">
              {selectedDate
                ? formatDay(selectedDate, { weekday: "long", day: "numeric", month: "long" })
                : "Select a day"}
            </h3>
            {selectedDate && isDayLoaded(selectedDate) && (
              <p className="mt-0.5 text-xs text-white/60">
                {selectedBookings.length} booking{selectedBookings.length !== 1 ? "s" : ""}
              </p>
            )}
          </div>

          {!selectedDate ? (
            <div className="px-5 py-10 text-center text-sm text-white/60">Choose a day to see its bookings</div>
          ) : !isDayLoaded(selectedDate) ? (
            <div className="px-5 py-10 text-center text-sm text-white/70">
              {loading ? "Loading this day…" : "This day is outside the dates loaded."}
            </div>
          ) : selectedBookings.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-white/60">No bookings on this day</div>
          ) : (
            <div className="max-h-[480px] divide-y divide-white/5 overflow-y-auto">
              {selectedBookings.map((booking) => (
                <button
                  key={booking.id}
                  type="button"
                  onClick={() => onSelectBooking(booking)}
                  className="flex w-full items-start gap-3 px-5 py-4 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold"
                >
                  <div className="w-14 shrink-0 pt-0.5">
                    <span className="block text-xs font-semibold text-white">{formatTime(booking.start_time)}</span>
                    <span className="text-xs text-white/60">{booking.duration_min} min</span>
                  </div>
                  <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotClass(booking.status)}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">{booking.customer_name}</p>
                    <p className="truncate text-xs text-white/60">{booking.service_name}</p>
                    <p className="truncate text-xs text-white/60">
                      {booking.staff_name} · {statusLabel(booking.status)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="text-xs font-semibold text-gold">{formatPence(booking.amount_pence)}</span>
                    <svg aria-hidden className="ml-auto mt-1 h-3 w-3 text-white/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
