/**
 * The shop's calendar and clock, for the API's "today" and hour-of-day
 * answers. Workers run in UTC, but a UK shop's day starts at midnight London
 * time: an hour before UTC's in British Summer Time.
 *
 * shops.timezone defaults to Europe/London and no route writes it yet, so in
 * practice every shop is on London time. The booking worker writes
 * booking_date as the shop's date of the booking's start, and takes its own
 * "today" from the shop's calendar too (apps/workers/booking/src/lib/time.ts).
 * Online bookings written before that change hold the UTC date of the start,
 * which differs only for a start between 00:00 and 01:00 London in summer.
 */

import { shiftDate, zonedTimeToUtc } from "@repo/utils";

export const PLATFORM_TIME_ZONE = "Europe/London";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | null | undefined): Intl.DateTimeFormat {
  const zone = timeZone || PLATFORM_TIME_ZONE;
  const cached = formatters.get(zone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
    });
  } catch (error) {
    // An unknown zone must not take a dashboard down: read London's clock.
    if (error instanceof RangeError && zone !== PLATFORM_TIME_ZONE) return formatterFor(PLATFORM_TIME_ZONE);
    throw error;
  }
  formatters.set(zone, formatter);
  return formatter;
}

function partsAt(instant: Date, timeZone: string | null | undefined) {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The shop's date now, "YYYY-MM-DD" (London when the zone is missing or unknown). */
export function shopToday(timeZone?: string | null, now: Date = new Date()): string {
  const { year, month, day } = partsAt(now, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * A real calendar day, "YYYY-MM-DD". Not month 00 or 13, and not 30 February,
 * which Date would quietly roll over to 2 March.
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const noon = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(noon.getTime()) && noon.toISOString().slice(0, 10) === value;
}

/**
 * The schedules.day_of_week for a calendar date: Monday-first (0=Mon..6=Sun),
 * as the admin schedule editor writes it. -1, which no row has, for anything
 * but a real "YYYY-MM-DD".
 */
export function scheduleDayOf(date: string): number {
  if (!isCalendarDate(date)) return -1;
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

/** An instant as D1's datetime() writes it: "YYYY-MM-DD HH:MM:SS", UTC. */
function asDbTimestamp(instant: Date): string {
  return instant.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The shop days `from` to `to` (inclusive calendar days, already checked with
 * isCalendarDate) as UTC timestamps: `start` inclusive, `end` exclusive. A day
 * is 23 or 25 hours long when the clocks change. Compare with
 * `datetime(created_at)`, which reads D1's "YYYY-MM-DD HH:MM:SS" and an ISO
 * timestamp alike (a plain text comparison would not: " " sorts before "T").
 */
export function shopDaysWindow(from: string, to: string, timeZone?: string | null): { start: string; end: string } {
  // The zone formatterFor settled on: London for a missing or unknown one.
  const zone = formatterFor(timeZone).resolvedOptions().timeZone;
  return {
    start: asDbTimestamp(zonedTimeToUtc(from, "00:00", zone)),
    end: asDbTimestamp(zonedTimeToUtc(shiftDate(to, 1), "00:00", zone)),
  };
}

/** The first day of the month `monthsBack` months before the shop's current month, "YYYY-MM-01". */
export function shopMonthStart(monthsBack: number, timeZone?: string | null, now: Date = new Date()): string {
  const { year, month } = partsAt(now, timeZone);
  const index = year * 12 + (month - 1) - monthsBack;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}-01`;
}

/**
 * The SQL bucket for a booking's start hour. bookings.start_time holds either
 * an instant (online bookings: "2026-07-01T09:00:00.000Z"), bucketed by UTC
 * date and hour, or a walk-in or deposit booking's own clock reading
 * ("09:30", the booking worker's slot_time), bucketed as "wall:09".
 */
export const START_HOUR_BUCKET_SQL =
  "CASE WHEN start_time GLOB '[0-9][0-9][0-9][0-9]-*' THEN strftime('%Y-%m-%dT%H', start_time) " +
  "ELSE 'wall:' || strftime('%H', start_time) END";

const WALL_BUCKET = /^wall:(\d{2})$/;
const UTC_BUCKET = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/;

/**
 * Turns START_HOUR_BUCKET_SQL counts into counts per hour of the shop's day.
 * A UTC hour maps to one shop hour: exact for whole-hour zones such as
 * London, whose clock changes fall on whole UTC hours.
 */
export function peakHoursInShopTime(
  rows: Array<{ bucket: string | null; booking_count: number }>,
  timeZone?: string | null,
): Array<{ hour: number; booking_count: number }> {
  const totals = new Map<number, number>();
  for (const row of rows) {
    let hour: number | null = null;
    const wall = row.bucket ? WALL_BUCKET.exec(row.bucket) : null;
    const utc = row.bucket ? UTC_BUCKET.exec(row.bucket) : null;
    if (wall) hour = Number(wall[1]);
    else if (utc) hour = partsAt(new Date(`${utc[1]}T${utc[2]}:00:00Z`), timeZone).hour;
    if (hour === null || Number.isNaN(hour)) continue;
    totals.set(hour, (totals.get(hour) ?? 0) + Number(row.booking_count));
  }
  return [...totals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, booking_count]) => ({ hour, booking_count }));
}
