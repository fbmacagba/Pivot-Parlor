import { Link } from "react-router";
import { Check, ChevronRight } from "lucide-react";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { formatDay, formatTime } from "~/lib/dateFormat";
import { useShopHref } from "~/lib/useShopHref";
import { BookingActions } from "./BookingActions";

export interface RowBooking {
  id: string;
  booking_date: string;
  start_time: string;
  status: string;
  customer_name: string;
  service_name: string;
  duration_min: number;
}

/** "09:05" on the London clock; a walk-in's own "09:30" as written. */
export function bookingClock(time: string): string {
  return formatTime(time, { hour: "2-digit", minute: "2-digit" }) || time;
}

/**
 * One booking in a staff list: a link to the booking (notes, contact
 * details, both actions), its status, and the one action it most likely
 * needs next. `readOnly` (a developer viewing) hides the action.
 */
export function BookingRow({
  booking,
  today,
  readOnly,
  showDate = false,
  highlight = false,
}: {
  booking: RowBooking;
  today: string;
  readOnly: boolean;
  /** Lists that span days show the day under the time. */
  showDate?: boolean;
  /** The row the Today screen is leading with. */
  highlight?: boolean;
}) {
  const shopHref = useShopHref();
  const time = bookingClock(booking.start_time);
  const day = showDate ? formatDay(booking.booking_date, { day: "numeric", month: "short" }) : "";
  const done = booking.status === "completed";

  return (
    <li
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 ${
        highlight ? "border-gold/30 bg-gold/5" : "border-white/10 bg-dark-100"
      }`}
    >
      <Link
        to={shopHref(`/staff/bookings/${booking.id}`)}
        aria-label={`${booking.customer_name}, ${booking.service_name}, ${time}${day ? ` on ${day}` : ""}. Open booking`}
        className="tap-target flex min-w-[12rem] flex-1 items-center gap-3 rounded-lg px-1 py-1 transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      >
        <span className="w-16 shrink-0 text-center">
          <span className={`block text-sm font-semibold ${done ? "text-white/70" : "text-white"}`}>{time}</span>
          <span className="block text-xs text-white/60">{day || `${booking.duration_min}m`}</span>
        </span>
        <span className="h-8 w-px shrink-0 bg-white/10" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm font-medium ${done ? "text-white/70" : "text-white"}`}>
            {booking.customer_name}
          </span>
          <span className="block truncate text-xs text-white/60">
            {booking.service_name}
            {showDate ? ` · ${booking.duration_min}m` : ""}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-white/60" aria-hidden />
      </Link>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {done && <Check className="h-3.5 w-3.5 text-white/60" aria-hidden />}
        <StatusBadge status={booking.status} />
      </span>
      {!readOnly && <BookingActions booking={booking} today={today} show="next" size="sm" />}
    </li>
  );
}
