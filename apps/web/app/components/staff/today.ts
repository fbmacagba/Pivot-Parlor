/**
 * The logic behind the staff screens, kept apart from the markup so it can be
 * tested: which booking is "next", what a staff member may do to a booking,
 * and how a countdown reads.
 */
import { bookingInstantMs } from "~/lib/dateFormat";

export interface TimedBooking {
  booking_date: string;
  start_time: string;
  end_time?: string | null;
  status: string;
  duration_min?: number | null;
}

/** Statuses with nothing left to do. */
const FINISHED = new Set(["completed", "cancelled", "no_show"]);

/** When a booking starts and ends, or null when its start cannot be read. */
export function bookingSpan(b: TimedBooking): { startMs: number; endMs: number } | null {
  const startMs = bookingInstantMs(b.booking_date, b.start_time);
  if (startMs === null) return null;
  let endMs = bookingInstantMs(b.booking_date, b.end_time);
  // No readable end, or one at or before the start: use the service's length.
  if (endMs === null || endMs <= startMs) {
    endMs = startMs + Math.max(0, Number(b.duration_min) || 0) * 60_000;
  }
  return { startMs, endMs };
}

export type NextKind =
  /** Being served now. */
  | "in_progress"
  /** Not started, and its start is still ahead. */
  | "upcoming"
  /** Not started, its start has passed, its end has not. */
  | "due"
  /** Not started or finished, and its end has passed. */
  | "overdue";

export interface NextBooking<T> {
  booking: T;
  kind: NextKind;
  /** null when the booking's time could not be read. */
  startMs: number | null;
}

/**
 * The booking the Today screen leads with. The one in progress, if any.
 * Otherwise the first unfinished booking whose end is still ahead, so a
 * 09:00 booking nobody marked does not stay "next" all day. Otherwise the
 * earliest unfinished one, flagged overdue so it can be completed or left.
 */
export function pickNextBooking<T extends TimedBooking>(bookings: T[], nowMs: number): NextBooking<T> | null {
  const open = bookings
    .filter((b) => !FINISHED.has(b.status))
    .map((booking) => ({ booking, span: bookingSpan(booking) }))
    // Oldest first; a booking with no readable time goes last.
    .sort((a, b) => (a.span?.startMs ?? Infinity) - (b.span?.startMs ?? Infinity));
  if (open.length === 0) return null;

  const serving = open.find((o) => o.booking.status === "in_progress");
  if (serving) return { booking: serving.booking, kind: "in_progress", startMs: serving.span?.startMs ?? null };

  const ahead = open.find((o) => o.span !== null && o.span.endMs > nowMs);
  if (ahead?.span) {
    return {
      booking: ahead.booking,
      kind: ahead.span.startMs > nowMs ? "upcoming" : "due",
      startMs: ahead.span.startMs,
    };
  }

  const timed = open.find((o) => o.span !== null);
  if (timed?.span) return { booking: timed.booking, kind: "overdue", startMs: timed.span.startMs };
  // Nothing has a readable time: lead with the first, and claim nothing about the clock.
  return { booking: open[0]!.booking, kind: "upcoming", startMs: null };
}

/** "in 25m", "in 1h 5m". Minutes are rounded up, so "in 0m" never shows. */
export function countdownLabel(startMs: number, nowMs: number): string {
  const mins = Math.max(1, Math.ceil((startMs - nowMs) / 60_000));
  if (mins < 60) return `in ${mins}m`;
  const rest = mins % 60;
  return rest === 0 ? `in ${Math.floor(mins / 60)}h` : `in ${Math.floor(mins / 60)}h ${rest}m`;
}

export type StaffBookingAction = "in_progress" | "completed";

/**
 * What a staff member can do to their booking, most likely first. The API
 * takes "in_progress" and "completed" only. A booking on a later day cannot
 * be started or completed yet.
 */
export function staffBookingActions(status: string, bookingDate: string, today: string): StaffBookingAction[] {
  if (bookingDate > today) return [];
  if (status === "pending" || status === "confirmed") return ["in_progress", "completed"];
  if (status === "in_progress") return ["completed"];
  return [];
}

/** The page size the booking lists grow by, and where they stop. */
export const LIST_PAGE = 20;
export const LIST_CAP = 100;

/** A list's ?limit= as a whole number of pages between one page and the cap. */
export function listLimit(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= LIST_PAGE) return LIST_PAGE;
  return Math.min(LIST_CAP, Math.ceil(n / LIST_PAGE) * LIST_PAGE);
}
