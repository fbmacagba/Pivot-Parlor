import { useState, useMemo } from "react";
import type { Booking, BookingStatus } from "~/routes/admin.bookings";

const STATUS_COLORS: Record<BookingStatus, string> = {
  confirmed: "bg-emerald-400",
  pending:   "bg-amber-400",
  completed: "bg-blue-400",
  cancelled: "bg-red-400",
  no_show:   "bg-white/30",
};

const STATUS_LABEL: Record<BookingStatus, string> = {
  confirmed: "Confirmed",
  pending:   "Pending",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show:   "No Show",
};

function formatTime(iso: string) {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const p = h >= 12 ? "pm" : "am";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${p}`;
}

interface BookingsCalendarProps {
  bookings: Booking[];
  onSelectBooking: (b: Booking) => void;
}

export function BookingsCalendar({ bookings, onSelectBooking }: BookingsCalendarProps) {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [selectedDate, setSelectedDate] = useState<string | null>(todayStr);

  const bookingsByDate = useMemo(() => {
    const map: Record<string, Booking[]> = {};
    for (const b of bookings) {
      if (!map[b.booking_date]) map[b.booking_date] = [];
      map[b.booking_date].push(b);
    }
    return map;
  }, [bookings]);

  const { calendarDays, monthLabel } = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const lastDay = new Date(viewYear, viewMonth + 1, 0);
    const startDow = (firstDay.getDay() + 6) % 7;
    const label = firstDay.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

    const days: Array<{ date: string | null; dayNum: number | null }> = [];
    for (let i = 0; i < startDow; i++) days.push({ date: null, dayNum: null });
    for (let d = 1; d <= lastDay.getDate(); d++) {
      const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      days.push({ date: dateStr, dayNum: d });
    }
    return { calendarDays: days, monthLabel: label };
  }, [viewMonth, viewYear]);

  const selectedBookings = selectedDate
    ? (bookingsByDate[selectedDate] ?? []).slice().sort((a, b) => a.start_time.localeCompare(b.start_time))
    : [];

  const prevMonth = () => {
    setSelectedDate(null);
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); }
    else setViewMonth((m) => m - 1);
  };

  const nextMonth = () => {
    setSelectedDate(null);
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); }
    else setViewMonth((m) => m + 1);
  };

  return (
    <div className="flex flex-col lg:flex-row gap-6">

      {/* Calendar grid */}
      <div className="flex-1 min-w-0">

        {/* Nav */}
        <div className="flex items-center justify-between mb-4">
          <button onClick={prevMonth} className="p-2 rounded-lg hover:bg-white/10 text-white/50 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-white">{monthLabel}</h2>
            <button
              onClick={() => { setViewMonth(today.getMonth()); setViewYear(today.getFullYear()); setSelectedDate(todayStr); }}
              className="text-xs px-2.5 py-1 rounded-full bg-white/10 text-white/60 hover:bg-white/20 font-medium transition-colors"
            >
              Today
            </button>
          </div>
          <button onClick={nextMonth} className="p-2 rounded-lg hover:bg-white/10 text-white/50 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 mb-1">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="text-center text-xs font-semibold text-white/30 py-2">{d}</div>
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

            const statusGroups = dayBookings.reduce<Partial<Record<BookingStatus, number>>>(
              (acc, b) => ({ ...acc, [b.status]: (acc[b.status as BookingStatus] ?? 0) + 1 }),
              {}
            );

            return (
              <button
                key={cell.date}
                onClick={() => setSelectedDate(isSelected ? null : cell.date)}
                className={[
                  "h-[72px] rounded-xl p-2 flex flex-col items-start border transition-all",
                  isSelected
                    ? "bg-gold/20 border-gold/50 shadow-md"
                    : isToday
                    ? "bg-white/10 border-white/20 hover:border-white/30"
                    : hasBookings
                    ? "bg-dark-100 border-white/10 hover:border-white/20"
                    : "bg-transparent border-transparent hover:bg-white/5",
                ].join(" ")}
              >
                <span className={[
                  "text-sm font-semibold w-6 h-6 flex items-center justify-center rounded-full",
                  isSelected ? "text-gold" : isToday ? "bg-gold text-dark font-bold" : "text-white/70",
                ].join(" ")}>
                  {cell.dayNum}
                </span>

                {hasBookings && (
                  <div className="mt-auto w-full">
                    <span className="text-[10px] text-white/30">
                      {dayBookings.length} bkg{dayBookings.length !== 1 ? "s" : ""}
                    </span>
                    <div className="flex gap-0.5 mt-0.5 flex-wrap">
                      {(Object.entries(statusGroups) as [BookingStatus, number][]).map(([status]) => (
                        <span key={status} className={`w-2 h-2 rounded-full ${STATUS_COLORS[status]}`} title={STATUS_LABEL[status]} />
                      ))}
                    </div>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-4 mt-4 text-xs text-white/30">
          {(Object.entries(STATUS_COLORS) as [BookingStatus, string][]).map(([status, color]) => (
            <div key={status} className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${color}`} />
              {STATUS_LABEL[status]}
            </div>
          ))}
        </div>
      </div>

      {/* Day panel */}
      <div className="lg:w-72 shrink-0">
        <div className="rounded-xl border border-white/10 bg-dark-100 overflow-hidden sticky top-6">
          <div className="bg-white/5 px-5 py-4 border-b border-white/10">
            <h3 className="font-semibold text-white text-sm">
              {selectedDate
                ? new Date(selectedDate + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
                : "Select a day"}
            </h3>
            {selectedDate && (
              <p className="text-white/30 text-xs mt-0.5">
                {selectedBookings.length} booking{selectedBookings.length !== 1 ? "s" : ""}
              </p>
            )}
          </div>

          {!selectedDate ? (
            <div className="px-5 py-10 text-center text-white/20 text-sm">Click a day to see bookings</div>
          ) : selectedBookings.length === 0 ? (
            <div className="px-5 py-10 text-center text-white/20 text-sm">No bookings on this day</div>
          ) : (
            <div className="divide-y divide-white/5 max-h-[480px] overflow-y-auto">
              {selectedBookings.map((booking) => (
                <button
                  key={booking.id}
                  onClick={() => onSelectBooking(booking)}
                  className="w-full flex items-start gap-3 px-5 py-4 hover:bg-white/[0.03] transition-colors text-left"
                >
                  <div className="w-12 shrink-0 pt-0.5">
                    <span className="text-xs font-semibold text-white block">{formatTime(booking.start_time)}</span>
                    <span className="text-[10px] text-white/30">{booking.duration_min}m</span>
                  </div>
                  <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[booking.status]}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{booking.customer_name}</p>
                    <p className="text-xs text-white/40 truncate">{booking.service_name}</p>
                    <p className="text-xs text-white/30 truncate">{booking.staff_name}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="text-xs font-semibold text-gold">£{booking.amount.toFixed(2)}</span>
                    <svg className="w-3 h-3 text-white/20 ml-auto mt-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
