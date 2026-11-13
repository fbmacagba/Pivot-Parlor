/**
 * When a booking holds a barber, and whether another booking holds part of
 * that time: one copy for every worker that writes bookings (the booking
 * worker's inserts, the API's status changes), so they cannot drift apart.
 *
 * bookings.start_time and end_time hold one of two shapes:
 *  - an instant, "2099-07-15T08:30:00.000Z": online bookings (POST /public/bookings);
 *  - the shop's own clock reading, "09:30", on booking_date: walk-ins and
 *    staff deposit bookings, copied from bw_availability.slot_time.
 *
 * Comparing the two shapes as text means nothing ("20:00" sorts after
 * "2099-..."), so every overlap query splits them with these predicates and
 * reads a clock reading on the shop's wall clock. Workers ship full ICU, so
 * Intl handles the DST tables.
 */

/** Offset of `tz` from UTC (ms) at the given instant. Positive = ahead of UTC. */
function tzOffsetMs(tz: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - instant.getTime();
}

/** The shop's wall clock at `instant` in `tz`, as "YYYY-MM-DD HH:MM". */
export function zonedWallClock(instant: Date, tz: string): string {
  const local = new Date(instant.getTime() + tzOffsetMs(tz, instant)).toISOString();
  return `${local.slice(0, 10)} ${local.slice(11, 16)}`;
}

/**
 * UTC instant for wall-clock `time` ("HH:MM") on calendar `date` ("YYYY-MM-DD")
 * in `tz`. Two-pass so dates around a DST transition resolve with the offset
 * that is actually in force at the resulting instant.
 */
export function zonedTimeToUtc(date: string, time: string, tz: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  const first = new Date(guess.getTime() - tzOffsetMs(tz, guess));
  const offset = tzOffsetMs(tz, first);
  return new Date(guess.getTime() - offset);
}

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

/** Statuses that hold no time: the time may be booked again. */
export const INACTIVE_BOOKING_STATUSES = ["cancelled", "no_show"] as const;

/**
 * SQL: another active booking of the same staff member holds part of an
 * interval. Binds, in order, from bookingClashBinds. It mirrors the booking
 * worker's checkSlotConflict: an instant row compares as instants (text, as
 * toISOString writes them); a clock row compares on the shop's wall clock,
 * its end rolling to the next day when at or before its start. A clock row
 * whose times are not "HH:MM" is ignored, as bookingInterval ignores it. On
 * the night the clocks go back, the repeated hour (01:00 to 02:00) reads as
 * one hour.
 *
 * Inside a write (INSERT ... SELECT ... WHERE NOT <this>, or a guarded
 * UPDATE) the check and the write are one statement, which D1 runs
 * atomically: nothing can take the time in between.
 */
export const BOOKING_CLASH_SQL = `EXISTS (
  SELECT 1 FROM bookings
  WHERE staff_id = ?
    AND id <> ?
    AND status NOT IN ('cancelled', 'no_show')
    AND ((${INSTANT_START_SQL} AND start_time < ? AND end_time > ?)
      OR (${CLOCK_START_SQL}
          AND start_time GLOB '[0-2][0-9]:[0-5][0-9]'
          AND end_time GLOB '[0-2][0-9]:[0-5][0-9]'
          AND booking_date BETWEEN ? AND ?
          AND booking_date || ' ' || start_time < ?
          AND (CASE WHEN end_time <= start_time THEN date(booking_date, '+1 day') ELSE booking_date END) || ' ' || end_time > ?))
)`;

/** The values BOOKING_CLASH_SQL binds, for `interval` held by `staffId` (`excludeId`'s own row aside). */
export function bookingClashBinds(
  staffId: string,
  excludeId: string,
  interval: { start: Date; end: Date },
  timeZone: string
): Array<string> {
  const startLocal = zonedWallClock(interval.start, timeZone);
  const endLocal = zonedWallClock(interval.end, timeZone);
  return [
    staffId,
    excludeId,
    interval.end.toISOString(),
    interval.start.toISOString(),
    shiftDate(startLocal.slice(0, 10), -1),
    endLocal.slice(0, 10),
    endLocal,
    startLocal,
  ];
}
