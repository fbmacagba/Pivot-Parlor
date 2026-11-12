/**
 * bookings.start_time and end_time hold one of two shapes:
 *  - an instant, "2099-07-15T08:30:00.000Z": online bookings (POST /public/bookings);
 *  - the shop's own clock reading, "09:30", on booking_date: walk-ins and
 *    staff deposit bookings, copied from bw_availability.slot_time.
 *
 * Comparing the two shapes as text means nothing ("20:00" sorts after
 * "2099-..."), so every overlap query splits them with these predicates and
 * reads a clock reading as instants in the shop's time zone.
 */
import { zonedTimeToUtc } from "./timezone.js";

/** SQL: the row's start_time is an instant. */
export const INSTANT_START_SQL = "start_time GLOB '[0-9][0-9][0-9][0-9]-*'";
/** SQL: the row's start_time is a clock reading on booking_date. */
export const CLOCK_START_SQL = `NOT (${INSTANT_START_SQL})`;

const INSTANT = /^\d{4}-/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface BookingTimes {
  booking_date: string;
  start_time: string;
  end_time: string;
}

/** The calendar date `days` days after `date` ("YYYY-MM-DD"). */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The booking's start and end instants. A clock reading is read on
 * booking_date in `timeZone`; an end at or before the start ran past midnight
 * (addMinutesToHm wraps "23:30" + 60 minutes to "00:30"). null for a row whose
 * times cannot be read.
 */
export function bookingInterval(row: BookingTimes, timeZone: string): { start: Date; end: Date } | null {
  if (INSTANT.test(row.start_time)) {
    const start = new Date(row.start_time);
    const end = new Date(row.end_time);
    return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ? null : { start, end };
  }
  if (!DATE.test(row.booking_date) || !CLOCK.test(row.start_time) || !CLOCK.test(row.end_time)) return null;
  const start = zonedTimeToUtc(row.booking_date, row.start_time, timeZone);
  let end = zonedTimeToUtc(row.booking_date, row.end_time, timeZone);
  if (end <= start) end = zonedTimeToUtc(shiftDate(row.booking_date, 1), row.end_time, timeZone);
  return { start, end };
}
