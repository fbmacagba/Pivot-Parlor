import { shiftDate } from "@repo/utils";

/**
 * Which bookings the owner's Bookings page loads.
 *
 * The API returns bookings oldest first and at most BOOKINGS_LIMIT of them.
 * Asking for everything meant a busy shop saw only its oldest rows, so the
 * page always asks for a dated window:
 *
 * - no dates chosen: 30 days back to 90 days ahead of today;
 * - both chosen: exactly those (swapped if they are the wrong way round);
 * - one chosen: SINGLE_SIDED_DAYS from it in the open direction.
 *
 * The page shows the window it used, and says so when the limit cut it short.
 */
export const BOOKINGS_LIMIT = 1000;
export const DEFAULT_DAYS_BACK = 30;
export const DEFAULT_DAYS_AHEAD = 90;
export const SINGLE_SIDED_DAYS = 120;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function validDay(value: string | null | undefined): string | null {
  const v = value?.trim() ?? "";
  if (!DAY.test(v)) return null;
  // "2026-02-31" matches the pattern but is not a day.
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

export interface BookingsWindow {
  from: string;
  to: string;
  /** True when the person chose neither date. */
  isDefault: boolean;
}

export function bookingsWindow(
  fromParam: string | null | undefined,
  toParam: string | null | undefined,
  today: string,
): BookingsWindow {
  const from = validDay(fromParam);
  const to = validDay(toParam);
  if (from && to) return from <= to ? { from, to, isDefault: false } : { from: to, to: from, isDefault: false };
  if (from) return { from, to: shiftDate(from, SINGLE_SIDED_DAYS), isDefault: false };
  if (to) return { from: shiftDate(to, -SINGLE_SIDED_DAYS), to, isDefault: false };
  return { from: shiftDate(today, -DEFAULT_DAYS_BACK), to: shiftDate(today, DEFAULT_DAYS_AHEAD), isDefault: true };
}

/** The query string for `GET /api/shops/:shopId/bookings`. */
export function bookingsQuery(window: BookingsWindow, status: string): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  params.set("date_from", window.from);
  params.set("date_to", window.to);
  params.set("limit", String(BOOKINGS_LIMIT));
  return `?${params}`;
}

/** First and last day of a month (month is 0 to 11). */
export function monthRange(year: number, month: number): { from: string; to: string } {
  const mm = String(month + 1).padStart(2, "0");
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, "0")}` };
}

/** True when every day of the month is inside the loaded window. */
export function monthIsLoaded(year: number, month: number, window: { from: string; to: string }): boolean {
  const range = monthRange(year, month);
  return range.from >= window.from && range.to <= window.to;
}

/** A case-blind match on the customer, the service or the staff member. */
export function matchesBookingSearch(
  booking: { customer_name?: string | null; service_name?: string | null; staff_name?: string | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [booking.customer_name, booking.service_name, booking.staff_name].some((field) =>
    (field ?? "").toLowerCase().includes(q),
  );
}
