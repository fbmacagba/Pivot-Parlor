import { clsx } from "clsx";

export interface TimelineBooking {
  id: string;
  customerName: string;
  service: string;
  staffName: string;
  startTime: string;
  endTime: string;
  status: "pending" | "confirmed" | "completed" | "cancelled" | "no_show";
}

const statusStyles: Record<TimelineBooking["status"], string> = {
  pending: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  confirmed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  cancelled: "bg-red-500/20 text-red-400 border-red-500/30",
  no_show: "bg-white/10 text-white/40 border-white/10",
};

interface BookingTimelineProps {
  bookings: TimelineBooking[];
}

export function BookingTimeline({ bookings }: BookingTimelineProps) {
  if (bookings.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl border border-white/10 bg-dark-100">
        <p className="text-sm text-white/40">No bookings today</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {bookings.map((b) => (
        <div
          key={b.id}
          className="flex items-start gap-4 rounded-xl border border-white/10 bg-dark-100 p-4"
        >
          <div className="text-right min-w-[4rem]">
            <p className="text-sm font-mono text-white/70">{b.startTime}</p>
            <p className="text-xs text-white/50">{b.endTime}</p>
          </div>
          <div className="h-full w-px bg-gold/20 self-stretch" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-white truncate">{b.customerName}</p>
            <p className="text-sm text-white/60">{b.service}</p>
            <p className="text-xs text-white/40">{b.staffName}</p>
          </div>
          <span
            className={clsx(
              "shrink-0 rounded-full border px-2.5 py-0.5 text-xs",
              statusStyles[b.status]
            )}
          >
            {b.status}
          </span>
        </div>
      ))}
    </div>
  );
}
